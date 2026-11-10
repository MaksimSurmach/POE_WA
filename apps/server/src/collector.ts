import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '@poe-worksmith/domain';
import { CronExpressionParser } from 'cron-parser';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Notification, Pool, PoolClient } from 'pg';
import { z } from 'zod';

import {
  writeCaptureInTransaction,
  type CaptureInput,
} from './repositories/captureRepository.js';
import { collectorSchedule, collectorState, runRequests } from './schema.js';

export type CollectorSchedule = typeof collectorSchedule.$inferSelect;
export type CollectorResult =
  | { status: 'success'; capture?: Omit<CaptureInput, 'scheduleId'> }
  | { status: 'retry'; reason: string; retryAt?: Date }
  | { status: 'blocked'; reason: string };
export type CollectorHandler = (
  schedule: CollectorSchedule,
  signal: AbortSignal,
  client: PoolClient,
  recoverTradeAuthentication: boolean,
) => Promise<CollectorResult>;

type CollectorOptions = {
  pool: Pool;
  signal: AbortSignal;
  handlers: Record<
    'trade-target' | 'economy' | 'league' | 'retention',
    CollectorHandler
  >;
  now?: () => Date;
  jitterMs?: () => number;
  maxIdleMs?: number | undefined;
  onError?: (code: string) => void;
  bootstrap?: (client: PoolClient, signal: AbortSignal) => Promise<void>;
};

type CollectorDb = NodePgDatabase;
type RunRequest = typeof runRequests.$inferSelect;
const progressSchema = z.object({
  pending: z.array(z.uuid()),
  recoverTradeAuthentication: z.literal(true).optional(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
type RequestProgress = z.infer<typeof progressSchema>;
type ActiveRequest = { id: string; progress: RequestProgress };

const minuteMs = 60_000;
const leaseMs = 10 * minuteMs;

function failureCode(error: unknown, fallback: string) {
  return error instanceof DomainError ? error.code : fallback;
}

async function transaction<T>(client: PoolClient, write: () => Promise<T>) {
  await client.query('begin isolation level read committed');
  try {
    const result = await write();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

async function saveState(
  db: CollectorDb,
  changes: Omit<typeof collectorState.$inferInsert, 'id'>,
) {
  await db
    .insert(collectorState)
    .values({ id: 1, ...changes })
    .onConflictDoUpdate({ target: collectorState.id, set: changes });
}

async function saveProgress(
  db: CollectorDb,
  request: ActiveRequest,
  now: Date,
) {
  const { progress } = request;
  const unavailable =
    progress.pending.length === 0 &&
    progress.succeeded === 0 &&
    progress.failed === 0;
  await db
    .update(runRequests)
    .set({
      summary: unavailable
        ? { ...progress, error: 'COLLECTOR_NO_ELIGIBLE_TARGETS' }
        : progress,
      ...(progress.pending.length === 0
        ? {
            state: progress.failed || unavailable ? 'failed' : 'done',
            finishedAt: now,
          }
        : {}),
    })
    .where(eq(runRequests.id, request.id));
}

async function startRequest(
  client: PoolClient,
  db: CollectorDb,
  request: RunRequest,
  now: Date,
) {
  return transaction(client, async () => {
    const rows = await db
      .update(collectorSchedule)
      .set({
        nextDueAt: sql`least(${collectorSchedule.nextDueAt}, ${now.toISOString()}::timestamptz)`,
        retryAt: null,
      })
      .where(
        and(
          eq(collectorSchedule.enabled, true),
          request.scope === 'recipe'
            ? and(
                eq(collectorSchedule.kind, 'trade-target'),
                sql`(${collectorSchedule.payload}->'recipeIds') ? ${request.recipeId}`,
              )
            : undefined,
        ),
      )
      .returning({ id: collectorSchedule.id, kind: collectorSchedule.kind });
    const [state] = await db
      .select({ blocked: collectorState.blockedReason })
      .from(collectorState)
      .where(eq(collectorState.id, 1));
    const active: ActiveRequest = {
      id: request.id,
      progress: {
        pending: rows.map(({ id }) => id),
        succeeded: 0,
        failed: 0,
        ...(state?.blocked && rows.some(({ kind }) => kind === 'trade-target')
          ? { recoverTradeAuthentication: true }
          : {}),
      },
    };
    await db
      .update(runRequests)
      .set({ state: 'running', startedAt: now })
      .where(eq(runRequests.id, request.id));
    await saveProgress(db, active, now);
    return active;
  });
}

async function readRequest(client: PoolClient, db: CollectorDb, now: Date) {
  const [request] = await db
    .select()
    .from(runRequests)
    .where(inArray(runRequests.state, ['running', 'queued']))
    .orderBy(
      sql`(${runRequests.state} = 'running') desc`,
      asc(runRequests.requestedAt),
      asc(runRequests.id),
    )
    .limit(1);
  if (!request) return;
  if (request.state === 'queued') return startRequest(client, db, request, now);

  const progress = progressSchema.safeParse(request.summary);
  if (progress.success) return { id: request.id, progress: progress.data };
  await db
    .update(runRequests)
    .set({
      state: 'failed',
      finishedAt: now,
      summary: { error: 'COLLECTOR_REQUEST_PROGRESS_INVALID' },
    })
    .where(eq(runRequests.id, request.id));
  return null;
}

async function nextSchedule(
  client: PoolClient,
  tradeBlocked: boolean,
  pending: string[],
  now: Date,
  recoverTradeAuthentication: boolean,
) {
  const { rows } = await client.query<{ id: string; due: Date }>(
    `with trade_cooldown as (
       select max(blocked_until) as until from rate_limit_states r
       where r.policy in ('poe-trade', 'trade-search-request-limit', 'trade-fetch-request-limit')
          or exists (
            select 1 from rate_limit_endpoint_policies p
            where p.policy = r.policy and p.endpoint in ('trade', 'trade-search', 'trade-fetch')
          )
     ), eligible as (
       select id, kind,
              greatest(next_due_at, retry_at, leased_until,
                case when kind = 'trade-target' then trade_cooldown.until end) as due
       from collector_schedule cross join trade_cooldown
       where enabled and (
         kind <> 'trade-target' or not $1::boolean
           or ($4::boolean and id = any($2::uuid[]))
       )
     )
     select id, due from eligible
     order by (id = any($2::uuid[]) and due <= $3::timestamptz) desc,
              due, case kind when 'league' then 0 when 'economy' then 1 else 2 end, id
     limit 1`,
    [tradeBlocked, pending, now, recoverTradeAuthentication],
  );
  return rows[0];
}

async function skipUnavailable(
  db: CollectorDb,
  request: ActiveRequest,
  tradeBlocked: boolean,
  now: Date,
) {
  if (request.progress.pending.length === 0) return true;
  const enabled = await db
    .select({ id: collectorSchedule.id })
    .from(collectorSchedule)
    .where(
      and(
        inArray(collectorSchedule.id, request.progress.pending),
        eq(collectorSchedule.enabled, true),
        tradeBlocked
          ? sql`${collectorSchedule.kind} <> 'trade-target'`
          : undefined,
      ),
    );
  if (enabled.length === request.progress.pending.length) return false;

  request.progress.failed += request.progress.pending.length - enabled.length;
  request.progress.pending = enabled.map(({ id }) => id);
  await saveProgress(db, request, now);
  return request.progress.pending.length === 0;
}

async function claimSchedule(
  client: PoolClient,
  db: CollectorDb,
  id: string,
  now: Date,
  recoveryRequest: ActiveRequest | undefined,
) {
  return transaction(client, async () => {
    const [schedule] = await db
      .update(collectorSchedule)
      .set({
        leasedUntil: new Date(now.getTime() + leaseMs),
        lastStartedAt: now,
        lastStatus: 'running',
      })
      .where(
        and(
          eq(collectorSchedule.id, id),
          eq(collectorSchedule.enabled, true),
          sql`greatest(${collectorSchedule.nextDueAt}, ${collectorSchedule.retryAt}, ${collectorSchedule.leasedUntil}) <= ${now.toISOString()}::timestamptz`,
        ),
      )
      .returning();
    if (schedule) {
      if (schedule.kind === 'trade-target' && recoveryRequest) {
        // Consume recovery under the lease so a successor cannot repeat it.
        delete recoveryRequest.progress.recoverTradeAuthentication;
        await saveProgress(db, recoveryRequest, now);
      }
      await saveState(db, { lastRunStartedAt: now, lastRunStatus: 'running' });
    }
    return schedule;
  });
}

function advanceSchedule(schedule: CollectorSchedule, now: Date) {
  const { cron, timezone } = schedule.payload;
  return (schedule.kind === 'league' || schedule.kind === 'retention') &&
    typeof cron === 'string' &&
    typeof timezone === 'string'
    ? CronExpressionParser.parse(cron, { currentDate: now, tz: timezone })
        .next()
        .toDate()
    : new Date(now.getTime() + schedule.intervalMinutes * minuteMs);
}

async function finishSchedule(
  client: PoolClient,
  db: CollectorDb,
  schedule: CollectorSchedule,
  result: CollectorResult,
  request: ActiveRequest | undefined,
  now: Date,
  jitterMs: () => number,
) {
  await transaction(client, async () => {
    const [current] = await db
      .select()
      .from(collectorSchedule)
      .where(eq(collectorSchedule.id, schedule.id))
      .for('update');
    if (
      !current ||
      current.leasedUntil?.getTime() !== schedule.leasedUntil?.getTime()
    ) {
      throw new Error('Collector schedule lease no longer matches');
    }

    const lastStatus =
      result.status === 'success'
        ? 'succeeded'
        : result.status === 'blocked'
          ? 'blocked'
          : 'failed';
    const captureId =
      result.status === 'success' && result.capture
        ? await writeCaptureInTransaction(client, {
            ...result.capture,
            scheduleId: schedule.id,
          })
        : null;
    const backoff = () =>
      new Date(
        now.getTime() +
          Math.min(current.intervalMinutes, 2 ** current.attempt) * minuteMs +
          jitterMs(),
      );
    await db
      .update(collectorSchedule)
      .set({
        leasedUntil: null,
        lastFinishedAt: now,
        lastStatus,
        ...(result.status === 'success'
          ? {
              nextDueAt: advanceSchedule(current, now),
              attempt: 0,
              retryAt: null,
              lastError: null,
            }
          : {
              attempt: current.attempt + 1,
              retryAt:
                result.status === 'retry' &&
                result.retryAt &&
                result.retryAt > now
                  ? result.retryAt
                  : backoff(),
              lastError: result.reason,
            }),
      })
      .where(eq(collectorSchedule.id, schedule.id));

    await saveState(db, {
      lastRunFinishedAt: now,
      lastRunStatus: lastStatus,
      lastRunSummary: {
        scheduleId: schedule.id,
        kind: schedule.kind,
        ...(captureId ? { captureId } : {}),
        ...(result.status === 'success' ? {} : { error: result.reason }),
      },
      ...(schedule.kind === 'trade-target' && result.status !== 'retry'
        ? {
            blockedReason: result.status === 'blocked' ? result.reason : null,
            ...(result.status === 'success' ||
            [
              'PROVIDER_AUTH_FAILED',
              'PROVIDER_ACCESS_DENIED',
              'PROVIDER_CHALLENGE',
            ].includes(result.reason)
              ? { sessionCheckedAt: now }
              : {}),
          }
        : {}),
    });

    if (request?.progress.pending.includes(schedule.id)) {
      await saveProgress(
        db,
        {
          id: request.id,
          progress: {
            pending: request.progress.pending.filter(
              (id) => id !== schedule.id,
            ),
            ...(request.progress.recoverTradeAuthentication
              ? { recoverTradeAuthentication: true }
              : {}),
            succeeded:
              request.progress.succeeded + Number(result.status === 'success'),
            failed:
              request.progress.failed + Number(result.status !== 'success'),
          },
        },
        now,
      );
    }
  });
}

async function collectSession({
  pool,
  signal,
  handlers,
  now = () => new Date(),
  jitterMs = () => Math.floor(Math.random() * 15_000),
  maxIdleMs = 15 * minuteMs,
  bootstrap,
  onError,
}: CollectorOptions) {
  const client = await pool.connect();
  const disconnected = new AbortController();
  const stop = AbortSignal.any([signal, disconnected.signal]);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    client.release(true);
  };
  const onDisconnect = () => disconnected.abort();
  client.on('error', onDisconnect);
  client.on('end', onDisconnect);

  let wake: (() => void) | undefined;
  let revision = 0;
  const onNotification = ({ channel }: Notification) => {
    if (channel !== 'worksmith_wake') return;
    revision++;
    wake?.();
  };
  const onStop = () => wake?.();

  try {
    signal.throwIfAborted();
    signal.addEventListener('abort', release, { once: true });
    try {
      await client.query(
        "select pg_advisory_lock(hashtext('poe-worksmith:collector'))",
      );
    } finally {
      signal.removeEventListener('abort', release);
    }
    stop.throwIfAborted();
    client.on('notification', onNotification);
    stop.addEventListener('abort', onStop);
    await client.query('listen worksmith_wake');
    await client.query(
      'update collector_schedule set leased_until = null where leased_until <= $1',
      [now()],
    );
    const db = drizzle({ client });
    if (bootstrap) {
      const hasSchedules = async () =>
        (
          await client.query<{ ready: boolean }>(
            'select exists(select 1 from collector_schedule where enabled) as ready',
          )
        ).rows[0]?.ready;
      while (!stop.aborted && !(await hasSchedules())) {
        try {
          await bootstrap(
            client,
            AbortSignal.any([stop, AbortSignal.timeout(leaseMs)]),
          );
          if (await hasSchedules()) break;
          throw new Error('Collector bootstrap produced no enabled schedules');
        } catch (error) {
          stop.throwIfAborted();
          onError?.(failureCode(error, 'COLLECTOR_BOOTSTRAP_UNAVAILABLE'));
          await delay(Math.min(maxIdleMs, minuteMs), undefined, {
            signal: stop,
          });
        }
      }
    }
    while (!stop.aborted) {
      // A notification during the database scan must also interrupt the next sleep.
      const seen = revision;
      const timestamp = now();
      const request = await readRequest(client, db, timestamp);
      if (request === null) continue;
      const [state] = await db
        .select({ blocked: collectorState.blockedReason })
        .from(collectorState)
        .where(eq(collectorState.id, 1));
      const tradeBlocked = Boolean(state?.blocked);
      const recoverTradeAuthentication =
        tradeBlocked && request?.progress.recoverTradeAuthentication === true;
      if (
        request &&
        (await skipUnavailable(
          db,
          request,
          tradeBlocked && !recoverTradeAuthentication,
          timestamp,
        ))
      )
        continue;
      const next = await nextSchedule(
        client,
        tradeBlocked,
        request?.progress.pending ?? [],
        timestamp,
        recoverTradeAuthentication,
      );
      if (stop.aborted) break;
      if (!next || next.due > timestamp) {
        if (revision !== seen) continue;
        const waitMs = next
          ? Math.min(
              maxIdleMs,
              Math.max(0, next.due.getTime() - now().getTime()),
            )
          : maxIdleMs;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => wake?.(), waitMs);
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          };
        });
        continue;
      }
      const schedule = await claimSchedule(
        client,
        db,
        next.id,
        timestamp,
        recoverTradeAuthentication ? request : undefined,
      );
      if (!schedule) continue;

      const jobSignal = AbortSignal.any([
        disconnected.signal,
        AbortSignal.timeout(leaseMs),
      ]);
      let result: CollectorResult;
      try {
        result = await handlers[schedule.kind as keyof typeof handlers](
          schedule,
          jobSignal,
          client,
          recoverTradeAuthentication,
        );
        jobSignal.throwIfAborted();
      } catch (error) {
        disconnected.signal.throwIfAborted();
        result = {
          status: 'retry',
          reason: failureCode(error, 'COLLECTOR_HANDLER_FAILED'),
        };
      }

      disconnected.signal.throwIfAborted();
      try {
        await finishSchedule(
          client,
          db,
          schedule,
          result,
          request,
          now(),
          jitterMs,
        );
      } catch (error) {
        if (result.status !== 'success' || !result.capture) throw error;
        disconnected.signal.throwIfAborted();
        await finishSchedule(
          client,
          db,
          schedule,
          {
            status: 'retry',
            reason: 'CAPTURE_PERSISTENCE_FAILED',
          },
          request,
          now(),
          jitterMs,
        );
      }
    }
    if (!signal.aborted) disconnected.signal.throwIfAborted();
  } finally {
    stop.removeEventListener('abort', onStop);
    client.off('notification', onNotification);
    release();
    client.off('error', onDisconnect);
    client.off('end', onDisconnect);
  }
}

export async function runCollector(options: CollectorOptions) {
  while (!options.signal.aborted) {
    try {
      await collectSession(options);
    } catch (error) {
      if (options.signal.aborted) break;
      options.onError?.(failureCode(error, 'COLLECTOR_SESSION_LOST'));
      await delay(1000, undefined, { signal: options.signal }).catch(
        () => undefined,
      );
    }
  }
}
