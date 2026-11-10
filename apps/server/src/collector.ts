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
import {
  collectorHeartbeatMs,
  type CollectorTelemetry,
} from './observability/collectorTelemetry.js';
import { readCollectorQueue } from './repositories/collectorQueue.js';
import { collectorSchedule, collectorState, runRequests } from './schema.js';

export type CollectorSchedule = typeof collectorSchedule.$inferSelect;
export type CollectorResult =
  | { status: 'success'; capture?: Omit<CaptureInput, 'scheduleId'> }
  | {
      status: 'retry';
      reason: string;
      retryAt?: Date;
      economyUpdated?: boolean;
    }
  | { status: 'blocked'; reason: string };
export type CollectorHandler = (
  schedule: CollectorSchedule,
  signal: AbortSignal,
  client: PoolClient,
  recoverTradeAuthentication: boolean,
) => Promise<CollectorResult>;

type PublishResults = (
  schedule: CollectorSchedule,
  now: Date,
  client: PoolClient,
) => Promise<void>;

class RecipeResultWriteError extends Error {}

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
  onLeaderAcquired?: (client: PoolClient) => Promise<void>;
  bootstrap?: (client: PoolClient, signal: AbortSignal) => Promise<void>;
  publishResults?: PublishResults;
  telemetry?: CollectorTelemetry;
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
      })
      .where(
        and(
          eq(collectorSchedule.enabled, true),
          sql`not (${collectorSchedule.kind} in ('trade-target', 'economy') and
            coalesce((select settings->>'collectionsPaused' = 'true' from market_admin_settings where id = 1), false))`,
          sql`(${collectorSchedule.payload}->>'discovery') is distinct from 'true'`,
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

async function skipUnavailable(
  db: CollectorDb,
  request: ActiveRequest,
  tradeBlocked: boolean,
  now: Date,
  paused: boolean,
) {
  if (request.progress.pending.length === 0) return true;
  const enabled = await db
    .select({ id: collectorSchedule.id })
    .from(collectorSchedule)
    .where(
      and(
        inArray(collectorSchedule.id, request.progress.pending),
        eq(collectorSchedule.enabled, true),
        paused
          ? sql`${collectorSchedule.kind} not in ('trade-target', 'economy')`
          : undefined,
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
  publishResults?: PublishResults,
  telemetry?: CollectorTelemetry,
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
    if (publishResults) {
      try {
        await publishResults(current, now, client);
      } catch (cause) {
        throw new RecipeResultWriteError('RECIPE_RESULTS_PERSISTENCE_FAILED', {
          cause,
        });
      }
    }
    const backoff = () =>
      new Date(
        now.getTime() +
          Math.min(current.intervalMinutes, 2 ** current.attempt) * minuteMs +
          jitterMs(),
      );
    const explicitRetry =
      result.status === 'retry' && result.retryAt && result.retryAt > now
        ? new Date(result.retryAt.getTime() + jitterMs())
        : undefined;
    const attemptsExhausted = current.attempt >= 2;
    const retryAt =
      result.status === 'success'
        ? undefined
        : attemptsExhausted
          ? new Date(
              Math.max(
                advanceSchedule(current, now).getTime(),
                explicitRetry?.getTime() ?? 0,
              ),
            )
          : (explicitRetry ?? backoff());
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
              attempt: attemptsExhausted ? 0 : current.attempt + 1,
              retryAt,
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

    await telemetry?.finish(schedule, result, now, retryAt, captureId);

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
  onLeaderAcquired,
  publishResults,
  telemetry,
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
    await telemetry?.lead(client);
    await onLeaderAcquired?.(client);
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
        const job = {
          kind: 'league',
          id: null,
          payload: {},
          lastStartedAt: now(),
        };
        await telemetry?.start(job);
        try {
          await bootstrap(
            client,
            AbortSignal.any([stop, AbortSignal.timeout(leaseMs)]),
          );
          if (!(await hasSchedules()))
            throw new Error(
              'Collector bootstrap produced no enabled schedules',
            );
          await telemetry?.finish(job, { status: 'success' }, now());
          break;
        } catch (error) {
          stop.throwIfAborted();
          const reason = failureCode(error, 'COLLECTOR_BOOTSTRAP_UNAVAILABLE');
          await telemetry?.finish(job, { status: 'retry', reason }, now());
          onError?.(reason);
          await delay(Math.min(maxIdleMs, minuteMs), undefined, {
            signal: stop,
          });
        } finally {
          telemetry?.settle();
        }
      }
    }
    while (!stop.aborted) {
      // A notification during the database scan must also interrupt the next sleep.
      const seen = revision;
      const timestamp = now();
      const request = await readRequest(client, db, timestamp);
      if (request === null) continue;
      const queue = await readCollectorQueue(
        client,
        timestamp,
        request?.progress ?? { pending: [] },
      );
      const tradeBlocked = Boolean(queue.blocked);
      const recoverTradeAuthentication = tradeBlocked && queue.recovery;
      if (
        request &&
        (await skipUnavailable(
          db,
          request,
          tradeBlocked && !recoverTradeAuthentication,
          timestamp,
          queue.paused,
        ))
      )
        continue;
      if (stop.aborted) break;
      if (!queue.id || !queue.nextDueAt || queue.nextDueAt > timestamp) {
        if (telemetry) {
          if (queue.paused)
            await telemetry.operation('pause', 'COLLECTIONS_PAUSED');
          else if (queue.cooldownUntil)
            await telemetry.operation(
              'cooldown',
              queue.cooldownStatus === 429
                ? 'RATE_LIMITED'
                : (queue.cooldownStatus ?? 0) >= 500
                  ? 'PROVIDER_UNAVAILABLE'
                  : 'RESTRICTION',
              queue.cooldownUntil,
            );
          else if (tradeBlocked && !recoverTradeAuthentication)
            await telemetry.operation('auth-blocked', queue.blocked);
          else if (queue.pacingUntil)
            await telemetry.operation('permit', 'PACING', queue.pacingUntil);
          else if (queue.retryUntil)
            await telemetry.operation(
              'cooldown',
              queue.retryReason,
              queue.retryUntil,
            );
          else await telemetry.operation('idle', null, queue.nextDueAt);
        }
        if (revision !== seen) continue;
        const idleMs = telemetry
          ? Math.min(maxIdleMs, collectorHeartbeatMs)
          : maxIdleMs;
        const waitMs = queue.nextDueAt
          ? Math.min(
              idleMs,
              Math.max(0, queue.nextDueAt.getTime() - now().getTime()),
            )
          : idleMs;
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
        queue.id,
        timestamp,
        recoverTradeAuthentication ? request : undefined,
      );
      if (!schedule) continue;
      await telemetry?.start(schedule);

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
      const publish =
        (schedule.kind === 'trade-target' &&
          result.status === 'success' &&
          result.capture) ||
        (schedule.kind === 'economy' &&
          (result.status === 'success' ||
            (result.status === 'retry' && result.economyUpdated)))
          ? publishResults
          : undefined;
      if (publish) await telemetry?.operation('evaluation');
      try {
        await finishSchedule(
          client,
          db,
          schedule,
          result,
          request,
          now(),
          jitterMs,
          publish,
          telemetry,
        );
      } catch (error) {
        if (
          !(error instanceof RecipeResultWriteError) &&
          (result.status !== 'success' || !result.capture)
        )
          throw error;
        disconnected.signal.throwIfAborted();
        await finishSchedule(
          client,
          db,
          schedule,
          {
            status: 'retry',
            reason:
              error instanceof RecipeResultWriteError
                ? error.message
                : 'CAPTURE_PERSISTENCE_FAILED',
          },
          request,
          now(),
          jitterMs,
          undefined,
          telemetry,
        );
      }
      telemetry?.settle();
    }
    if (!signal.aborted) disconnected.signal.throwIfAborted();
  } finally {
    telemetry?.stop();
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
