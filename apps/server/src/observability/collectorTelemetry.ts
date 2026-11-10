import {
  collectorOperationSchema,
  collectorRateLimitSchema,
  collectorRateLimitedSchema,
  collectorRequestStatsSchema,
  collectorWaitStatsSchema,
  type CollectorDiagnostics,
  type CollectorOperation,
  type CollectorRateLimit,
  type CollectorRateLimited,
  type CollectorRequestStats,
  type CollectorWaitStats,
} from '@poe-worksmith/contracts';
import type { RateLimitState } from '@poe-worksmith/domain';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import type { CollectorResult, CollectorSchedule } from '../collector.js';
import {
  parseRetryAfter,
  type ParsedRateLimitHeaders,
} from '../rateLimitController.js';
import { readCollectorQueue } from '../repositories/collectorQueue.js';
import type { Metrics } from './metrics.js';

export const collectorHeartbeatMs = 2 * 60_000;
const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const transitionWriteIntervalMs = 10_000;

const measurementsSchema = z.object({
  requestMinutes: z
    .array(
      z.object({
        at: z.number(),
        requests: z.array(collectorRequestStatsSchema),
      }),
    )
    .default([]),
  waits: z.array(collectorWaitStatsSchema).default([]),
  last429: collectorRateLimitedSchema.nullable().default(null),
  capturedAt: z.iso.datetime().nullable().default(null),
  captureDurationMs: z.number().nullable().default(null),
});
type Measurements = z.infer<typeof measurementsSchema>;
type Operation = CollectorOperation['operation'];
type Provider = CollectorRequestStats['provider'];
type Endpoint = CollectorRequestStats['endpoint'];
type WaitReason = CollectorWaitStats['reason'];
type Run = Measurements & { id: string };
type Fetch = (
  input: URL | string | Request,
  init?: RequestInit,
) => Promise<Response>;

function durationRange(values: number[]) {
  return {
    average: values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null,
    max: values.length ? Math.max(...values) : null,
  };
}

function cleanCode(code: string | null | undefined) {
  return code && /^[A-Z][A-Z_0-9]{0,63}$/.test(code) ? code : null;
}

function countResponse(status: number | null) {
  if (status === null) return 'networkError';
  if (status >= 200 && status < 300) return 'success';
  if (status === 429) return 'rateLimited';
  if (status >= 401 && status <= 403) return 'auth';
  if (status >= 500) return 'serverError';
  return 'other';
}

function emptyRequest(
  provider: Provider,
  endpoint: Endpoint,
): CollectorRequestStats {
  return {
    provider,
    endpoint,
    success: 0,
    rateLimited: 0,
    auth: 0,
    serverError: 0,
    networkError: 0,
    other: 0,
  };
}

function requestTotal({
  success,
  rateLimited,
  auth,
  serverError,
  networkError,
  other,
}: CollectorRequestStats) {
  return success + rateLimited + auth + serverError + networkError + other;
}

/** Collect only fixed labels and sanitized measurements on the lock-owning worker. */
export class CollectorTelemetry {
  readonly #now: () => Date;
  readonly #metrics: Metrics | undefined;
  #client: PoolClient | undefined;
  #run: Run | undefined;
  #lastWrite = 0;
  #lastPrune = 0;
  #current: CollectorOperation | undefined;
  #rateLimits: Record<string, CollectorRateLimit> = {};

  constructor(options: { now?: () => Date; metrics?: Metrics } = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#metrics = options.metrics;
  }

  async lead(client: PoolClient) {
    this.#client = client;
    this.#run = undefined;
    this.#current = undefined;
    this.#rateLimits = {};
    this.#lastWrite = 0;
    this.#lastPrune = 0;
    const now = this.#now();
    await client.query(
      `with abandoned as (
         update collector_telemetry_runs
         set outcome = 'interrupted', finished_at = $1
         where outcome = 'running'
       )
       insert into collector_state (id, telemetry_started_at)
       values (1, $1) on conflict (id) do update
       set telemetry_started_at = coalesce(collector_state.telemetry_started_at, excluded.telemetry_started_at)`,
      [now],
    );
    await this.operation('idle');
  }

  stop() {
    this.#client = undefined;
    this.#run = undefined;
  }

  async start(
    schedule: Pick<CollectorSchedule, 'kind' | 'payload' | 'lastStartedAt'> & {
      id: string | null;
    },
  ) {
    const client = this.#client!;
    const {
      rows: [row],
    } = await client.query<{ id: string }>(
      `insert into collector_telemetry_runs (schedule_id, kind, started_at, outcome)
       values ($1, $2, $3, 'running') returning id`,
      [schedule.id, schedule.kind, schedule.lastStartedAt],
    );
    this.#run = { id: row!.id, ...measurementsSchema.parse({}) };
    const { recipeIds, discovery } = schedule.payload;
    const recipe =
      Array.isArray(recipeIds) &&
      recipeIds.find(
        (id: unknown) =>
          typeof id === 'string' && /^[a-z][a-z0-9-]{0,59}$/.test(id),
      );
    const target =
      typeof recipe === 'string'
        ? recipe
        : schedule.kind === 'trade-target'
          ? `${discovery ? 'discovery' : 'target'}-${schedule.id?.slice(0, 8)}`
          : null;
    this.#current = {
      operation:
        schedule.kind === 'trade-target'
          ? 'permit'
          : (schedule.kind as Operation),
      startedAt: this.#now().toISOString(),
      taskStartedAt: schedule.lastStartedAt?.toISOString() ?? null,
      target,
      reason: null,
      until: null,
    };
    await this.#persist(this.#now(), true);
  }

  async operation(
    operation: Operation,
    reason?: string | null,
    until?: Date | null,
  ) {
    const now = this.#now();
    const current = this.#current;
    const reasonCode = cleanCode(reason);
    const changed =
      !current ||
      current.operation !== operation ||
      current.reason !== reasonCode ||
      current.until !== (until?.toISOString() ?? null);
    if (changed) {
      this.#current = {
        operation,
        startedAt:
          current?.operation === operation
            ? current.startedAt
            : now.toISOString(),
        taskStartedAt: this.#run ? (current?.taskStartedAt ?? null) : null,
        target: this.#run ? (current?.target ?? null) : null,
        reason: reasonCode,
        until: until?.toISOString() ?? null,
      };
    }
    const elapsed = now.getTime() - this.#lastWrite;
    if (
      elapsed >= collectorHeartbeatMs ||
      (changed && (!this.#run || elapsed >= transitionWriteIntervalMs))
    )
      await this.#persist(now);
  }

  async #persist(now: Date, force = false) {
    if (!this.#client || !this.#current) return;
    const updateRun =
      this.#run &&
      (force || this.#run.requestMinutes.length || this.#run.waits.length);
    await this.#client.query(
      `with measurement as (
         update collector_telemetry_runs set measurements = $5
         where id = $4 and outcome = 'running'
       )
       update collector_state
       set telemetry_contacted_at = $1, telemetry_leader_pid = pg_backend_pid(),
           telemetry_current = $2, telemetry_rate_limits = telemetry_rate_limits || $3::jsonb
       where id = 1`,
      [
        now,
        this.#current,
        this.#rateLimits,
        updateRun ? this.#run!.id : null,
        this.#run ?? {},
      ],
    );
    this.#lastWrite = now.getTime();
    if (this.#lastPrune === 0 || now.getTime() - this.#lastPrune >= hourMs) {
      await this.#client.query(
        "delete from collector_telemetry_runs where started_at < $1 and outcome <> 'running'",
        [new Date(now.getTime() - 25 * hourMs)],
      );
      this.#lastPrune = now.getTime();
    }
  }

  async finish(
    schedule: Pick<CollectorSchedule, 'kind'>,
    result: CollectorResult,
    at: Date,
    retryAt?: Date,
    captureId?: string | null,
  ) {
    const run = this.#run;
    if (!run) return;
    const capture = result.status === 'success' ? result.capture : undefined;
    const outcome =
      schedule.kind === 'trade-target' && result.status !== 'success'
        ? 'failed'
        : 'other';
    run.capturedAt = capture?.capturedAt.toISOString() ?? null;
    run.captureDurationMs = capture?.durationMs ?? null;
    if (retryAt && result.status !== 'success') {
      this.wait(
        result.reason === 'PROVIDER_RATE_LIMITED' ||
          result.reason === 'ECONOMY_RATE_LIMITED'
          ? 'rate-limit'
          : result.reason === 'PROVIDER_UNAVAILABLE' ||
              result.reason === 'ECONOMY_UNAVAILABLE'
            ? 'provider-error'
            : 'retry',
        Math.max(0, retryAt.getTime() - at.getTime()),
      );
    }
    await this.#client!.query(
      `with evidence as (
         select id, complete, partial_reason, sorted_sample_ids from captures where id = $4
       ), measurement as (
         update collector_telemetry_runs set finished_at = $2,
           outcome = case
             when not exists (select 1 from evidence) then $3
             when exists (select 1 from evidence where complete and sorted_sample_ids is null) then 'complete'
             else 'partial'
           end,
           partial_reason = (select case when sorted_sample_ids is not null then 'SORTED_PREFIX'
                                         else partial_reason end from evidence),
           measurements = $5
         where id = $1 and outcome = 'running'
       )
       update collector_state set telemetry_contacted_at = $2, telemetry_rate_limits =
         telemetry_rate_limits || $6::jsonb where id = 1`,
      [run.id, at, outcome, captureId ?? null, run, this.#rateLimits],
    );
    this.#lastWrite = at.getTime();
  }

  settle() {
    this.#run = undefined;
    // A subsequent scheduler decision always replaces the in-flight status.
    this.#current = undefined;
  }

  wait(reason: WaitReason, durationMs: number) {
    const waits = this.#run?.waits;
    if (!waits) return;
    const wait = waits.find((row) => row.reason === reason);
    if (wait) {
      wait.count++;
      wait.durationMs += durationMs;
    } else waits.push({ reason, count: 1, durationMs });
  }

  rateLimit(
    endpoint: string,
    observed: ParsedRateLimitHeaders,
    state: RateLimitState,
  ) {
    if (
      !['trade-search', 'trade-fetch', 'trade-login', 'trade-leagues'].includes(
        endpoint,
      )
    )
      return;
    if (
      (state.lastStatus ?? 0) >= 200 &&
      (state.lastStatus ?? 0) < 300 &&
      observed.blockedForMs > 0
    )
      this.wait('restriction', observed.blockedForMs);
    this.#rateLimits[endpoint] = {
      endpoint,
      policy: state.policy,
      observedAt: (state.lastResponseAt ?? this.#now()).toISOString(),
      waitingUntil: new Date(
        Math.max(state.blockedUntil.getTime(), state.nextRequestAt.getTime()),
      ).toISOString(),
      blockedUntil: state.blockedUntil.toISOString(),
      headersComplete: observed.headersComplete,
      minimumDelayMs: state.minimumDelayMs,
      windows: observed.windows,
    };
  }

  recordResponse(
    provider: Provider,
    endpoint: Endpoint,
    status: number | null,
    headers?: Pick<Headers, 'get'>,
    durationMs = 0,
  ) {
    const run = this.#run;
    const outcome = countResponse(status);
    const labels = { provider, endpoint, outcome };
    this.#metrics?.providerRequests.inc(labels);
    this.#metrics?.providerRequestDuration.observe(labels, durationMs / 1000);
    if (!run) return;
    const now = this.#now();
    const minute = Math.floor(now.getTime() / minuteMs) * minuteMs;
    let bucket = run.requestMinutes.find(({ at }) => at === minute);
    if (!bucket) {
      bucket = { at: minute, requests: [] };
      run.requestMinutes.push(bucket);
    }
    let counters = bucket.requests.find(
      (row) => row.provider === provider && row.endpoint === endpoint,
    );
    if (!counters) {
      counters = emptyRequest(provider, endpoint);
      bucket.requests.push(counters);
    }
    counters[outcome]++;
    if (status === 429) {
      run.last429 = {
        at: now.toISOString(),
        retryAfterMs: parseRetryAfter(headers?.get('retry-after') ?? null, now),
      };
    }
  }

  fetch(provider: Provider, endpoint: Endpoint, send: Fetch = fetch): Fetch {
    return async (input, init) => {
      const run = this.#run;
      init?.signal?.throwIfAborted();
      const start = performance.now();
      try {
        const response = await send(input, init);
        if (run === this.#run)
          this.recordResponse(
            provider,
            endpoint,
            response.status,
            response.headers,
            performance.now() - start,
          );
        return response;
      } catch (error) {
        if (run === this.#run)
          this.recordResponse(
            provider,
            endpoint,
            null,
            undefined,
            performance.now() - start,
          );
        throw error;
      }
    };
  }
}

type RunRow = {
  schedule_id: string | null;
  kind: string;
  started_at: Date;
  finished_at: Date | null;
  outcome: string;
  partial_reason: string | null;
  measurements: unknown;
};

function summarize(
  rows: RunRow[],
  hours: 1 | 24,
  now: Date,
  trackedSince: Date | null,
): CollectorDiagnostics['windows'][number] {
  const from = new Date(
    Math.floor(now.getTime() / minuteMs) * minuteMs - hours * hourMs,
  );
  const requests = new Map<string, CollectorRequestStats>();
  const waits = new Map<WaitReason, CollectorWaitStats>();
  const targets = new Set<string>();
  const partialReasons: Record<string, number> = {};
  const durations: number[] = [];
  const searchRequests: number[] = [];
  const fetchRequests: number[] = [];
  const intervals: number[] = [];
  const observed = new Map<string, number>();
  let earliestCapture: string | null = null;
  let latestCapture: string | null = null;
  let complete = 0;
  let partial = 0;
  let failed = 0;
  let interrupted = 0;
  let planned = 0;
  let last429: CollectorRateLimited | null = null;
  for (const row of rows) {
    const inWindow = row.started_at >= from && row.started_at <= now;
    const { success, data } = measurementsSchema.safeParse(row.measurements);
    if (inWindow && row.kind === 'trade-target') {
      planned++;
      if (row.schedule_id) targets.add(row.schedule_id);
      if (row.outcome === 'failed') failed++;
      if (row.outcome === 'interrupted') interrupted++;
      if (row.outcome === 'partial') {
        partial++;
        const reason = cleanCode(row.partial_reason) ?? 'UNKNOWN';
        partialReasons[reason] = (partialReasons[reason] ?? 0) + 1;
      }
      if (row.outcome === 'complete') complete++;
      if (
        (row.outcome === 'complete' || row.outcome === 'partial') &&
        row.finished_at
      ) {
        durations.push(
          data?.captureDurationMs ??
            Math.max(0, row.finished_at.getTime() - row.started_at.getTime()),
        );
        if (success) {
          const captureRequests = data.requestMinutes.flatMap(
            (bucket) => bucket.requests,
          );
          searchRequests.push(
            captureRequests
              .filter((req) => req.endpoint === 'trade-search')
              .reduce((sum, req) => sum + requestTotal(req), 0),
          );
          fetchRequests.push(
            captureRequests
              .filter((req) => req.endpoint === 'trade-fetch')
              .reduce((sum, req) => sum + requestTotal(req), 0),
          );
          if (data.capturedAt && row.schedule_id) {
            if (!earliestCapture || data.capturedAt < earliestCapture)
              earliestCapture = data.capturedAt;
            if (!latestCapture || data.capturedAt > latestCapture)
              latestCapture = data.capturedAt;
            const timestamp = Date.parse(data.capturedAt);
            const previous = observed.get(row.schedule_id);
            if (previous !== undefined && timestamp > previous)
              intervals.push(timestamp - previous);
            observed.set(row.schedule_id, timestamp);
          }
        }
      }
    }
    if (!success) continue;
    const inWindowRequests = data.requestMinutes
      .filter(({ at }) => at >= from.getTime() && at <= now.getTime())
      .flatMap((bucket) => bucket.requests);
    for (const { provider, endpoint, ...counts } of inWindowRequests) {
      const key = `${provider}:${endpoint}`;
      const total = requests.get(key) ?? emptyRequest(provider, endpoint);
      for (const outcome of Object.keys(counts) as (keyof typeof counts)[])
        total[outcome] += counts[outcome];
      requests.set(key, total);
    }
    for (const { reason, count, durationMs } of inWindow ? data.waits : []) {
      const total = waits.get(reason) ?? { reason, count: 0, durationMs: 0 };
      total.count += count;
      total.durationMs += durationMs;
      waits.set(reason, total);
    }
    if (
      data.last429 &&
      Date.parse(data.last429.at) >= from.getTime() &&
      (!last429 || data.last429.at > last429.at)
    )
      last429 = data.last429;
  }
  return {
    hours,
    from: from.toISOString(),
    to: now.toISOString(),
    trackedSince: trackedSince
      ? new Date(Math.max(trackedSince.getTime(), from.getTime())).toISOString()
      : null,
    requests: [...requests.values()],
    waits: [...waits.values()],
    last429,
    captures: {
      planned,
      successful: complete + partial,
      complete,
      partial,
      failed,
      interrupted,
      targets: targets.size,
      partialReasons,
      durationMs: durationRange(durations),
      searchRequests: durationRange(searchRequests),
      fetchRequests: durationRange(fetchRequests),
      latestCaptureAt: latestCapture,
      observedSpanMs:
        earliestCapture && latestCapture
          ? Date.parse(latestCapture) - Date.parse(earliestCapture)
          : null,
      intervalMs: durationRange(intervals),
    },
  };
}

export async function readCollectorDiagnostics(
  pool: Pool,
  now = new Date(),
): Promise<CollectorDiagnostics> {
  const [
    queue,
    {
      rows: [state],
    },
    { rows },
  ] = await Promise.all([
    readCollectorQueue(pool, now),
    pool.query<{
      telemetry_started_at: Date | null;
      telemetry_contacted_at: Date | null;
      telemetry_leader_pid: number | null;
      telemetry_current: unknown;
      telemetry_rate_limits: unknown;
    }>(
      'select telemetry_started_at, telemetry_contacted_at, telemetry_leader_pid, telemetry_current, telemetry_rate_limits from collector_state where id = 1',
    ),
    pool.query<RunRow>(
      'select * from collector_telemetry_runs where started_at > $1 order by started_at',
      [new Date(now.getTime() - 25 * hourMs)],
    ),
  ]);
  const role =
    queue.leaderPid !== null ? 'leader' : queue.standby ? 'standby' : 'offline';
  const contactedAt = state?.telemetry_contacted_at ?? null;
  const sameLeader =
    queue.leaderPid !== null && queue.leaderPid === state?.telemetry_leader_pid;
  const limits = z
    .record(z.string(), collectorRateLimitSchema)
    .safeParse(state?.telemetry_rate_limits);
  return {
    role,
    contactedAt: contactedAt?.toISOString() ?? null,
    stale:
      !sameLeader ||
      !contactedAt ||
      now.getTime() - contactedAt.getTime() > 2 * collectorHeartbeatMs,
    current: sameLeader
      ? (collectorOperationSchema.safeParse(state?.telemetry_current).data ??
        null)
      : null,
    queue: {
      due: queue.due,
      enabled: queue.enabled,
      oldestDueAt: queue.oldestDueAt?.toISOString() ?? null,
      nextDueAt: queue.nextDueAt?.toISOString() ?? null,
      tradeCapturesPerHour: queue.tradeCapturesPerHour,
    },
    rateLimits: limits.success ? Object.values(limits.data) : [],
    windows: ([1, 24] as const).map((hours) =>
      summarize(rows, hours, now, state?.telemetry_started_at ?? null),
    ),
  };
}

export function createCollectorDiagnosticsReader(pool: Pool) {
  let cached:
    { at: number; promise: Promise<CollectorDiagnostics> } | undefined;
  return () => {
    const now = new Date();
    if (cached && now.getTime() - cached.at < 10_000) return cached.promise;
    const promise = readCollectorDiagnostics(pool, now).catch(
      (error: unknown) => {
        if (cached?.promise === promise) cached = undefined;
        throw error;
      },
    );
    cached = { at: now.getTime(), promise };
    return promise;
  };
}
