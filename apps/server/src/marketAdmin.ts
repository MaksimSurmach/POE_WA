import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import type { Pool, PoolClient } from 'pg';
import type { Db } from 'pg-boss';
import {
  marketAdminSettingsSchema,
  marketAdminPatchSchema,
  marketAdminRefreshSchema,
  marketAdminRunSchema,
  type MarketAdminSettings,
  type MarketAdminRefresh,
} from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';

export type AdminRefreshJob = MarketAdminRefresh & {
  source: 'manual' | 'scheduler';
};
export type AdminQueue = {
  enqueue(data: AdminRefreshJob, id: string, db: Db): Promise<string | null>;
  cancel(id: string): Promise<unknown>;
};

export function defaultAdminSettings(options: {
  refreshCron: string;
  requestTimeoutMs: number;
  concurrency: number;
  snapshotTtlMs: number;
}): MarketAdminSettings {
  return marketAdminSettingsSchema.parse({
    automaticRefreshEnabled: true,
    scheduledCollectionEnabled: true,
    collectionsPaused: false,
    manualRefreshEnabled: true,
    refreshCron: options.refreshCron,
    requestTimeoutMs: Math.min(
      30_000,
      Math.max(1000, options.requestTimeoutMs),
    ),
    collectionConcurrency: Math.min(4, options.concurrency),
    snapshotReuseTtlMs: Math.min(options.snapshotTtlMs, 30 * 60_000),
    freshnessWarningMs: 60 * 60_000,
    maximumQuoteAgeMs: 2 * 60 * 60_000,
    rawRetentionHours: 90 * 24,
    historyRetentionDays: 730,
  });
}

export function validateAdminSettings(value: unknown, timezone: string) {
  const parsed = marketAdminSettingsSchema.safeParse(value);
  if (!parsed.success) throw new DomainError('MARKET_QUERY_INVALID');
  const settings = parsed.data;
  if (
    settings.freshnessWarningMs > settings.maximumQuoteAgeMs ||
    settings.snapshotReuseTtlMs > settings.maximumQuoteAgeMs ||
    settings.rawRetentionHours > settings.historyRetentionDays * 24 ||
    settings.rawRetentionHours * 3_600_000 < settings.maximumQuoteAgeMs
  )
    throw new DomainError('MARKET_QUERY_INVALID');
  try {
    if (settings.refreshCron.trim().split(/\s+/).length !== 5)
      throw new Error('Five-field cron required');
    const cron = CronExpressionParser.parse(settings.refreshCron, {
      tz: timezone,
    });
    let previous = cron.next().getTime();
    for (let i = 0; i < 100; i++) {
      const next = cron.next().getTime();
      if (next - previous < 5 * 60_000)
        throw new Error('Minimum interval: five minutes');
      previous = next;
    }
  } catch {
    throw new DomainError('MARKET_QUERY_INVALID');
  }
  return settings;
}

export function createMarketAdminStore(options: {
  pool: Pool;
  defaults: MarketAdminSettings;
  timezone: string;
  concurrencyLimit: number;
}) {
  const { pool } = options;
  async function transaction<T>(fn: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async function audit(
    client: Pick<Pool, 'query'>,
    actor: string,
    action: string,
    details: Record<string, unknown>,
  ) {
    await client.query(
      'insert into market_admin_audit (actor,action,details) values ($1,$2,$3::jsonb)',
      [actor, action, JSON.stringify(details)],
    );
  }
  async function init() {
    const defaults = validateAdminSettings(options.defaults, options.timezone);
    await pool.query(
      'insert into market_admin_settings (id,settings) values (1,$1::jsonb) on conflict (id) do nothing',
      [JSON.stringify(defaults)],
    );
  }
  function response(row: { version: number; settings: unknown }) {
    const configured = marketAdminSettingsSchema.parse(row.settings);
    const effective = {
      ...configured,
      collectionConcurrency: Math.min(
        configured.collectionConcurrency,
        options.concurrencyLimit,
        4,
      ),
    };
    const interval = CronExpressionParser.parse(effective.refreshCron, {
      tz: options.timezone,
    });
    const gap = interval.next().getTime();
    const warnings: string[] = [];
    if (interval.next().getTime() - gap > effective.maximumQuoteAgeMs)
      warnings.push(
        'Collection interval exceeds maximum quote age. Quotes can expire before the next refresh; expired prices are hidden.',
      );
    if (effective.collectionConcurrency !== configured.collectionConcurrency)
      warnings.push(
        'Collection concurrency is capped by the deployment limit.',
      );
    return {
      version: row.version,
      configured,
      effective,
      restartRequired: false,
      applies:
        'New requests and runs use current settings; active requests finish with their starting settings. Scheduler reconciles within 5 seconds.',
      timezone: options.timezone,
      warnings,
    };
  }
  async function read() {
    const result = await pool.query<{ version: number; settings: unknown }>(
      'select version,settings from market_admin_settings where id=1',
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('PERSISTENCE_UNAVAILABLE');
    return response(row);
  }
  async function patch(
    input: unknown,
    actor: string,
    action = 'settings.update',
  ) {
    const parsed = marketAdminPatchSchema.safeParse(input);
    if (!parsed.success) throw new DomainError('MARKET_QUERY_INVALID');
    return transaction(async (client) => {
      const result = await client.query<{ version: number; settings: unknown }>(
        'select version,settings from market_admin_settings where id=1 for update',
      );
      const row = result.rows[0];
      if (!row || row.version !== parsed.data.version)
        throw new DomainError('PERSISTENCE_CONFLICT');
      const previous = marketAdminSettingsSchema.parse(row.settings);
      const settings = validateAdminSettings(
        { ...previous, ...parsed.data.settings },
        options.timezone,
      );
      await client.query(
        'update market_admin_settings set settings=$1::jsonb,version=version+1,updated_at=now() where id=1',
        [JSON.stringify(settings)],
      );
      await audit(client, actor, action, {
        previous,
        settings,
        version: row.version + 1,
      });
      return response({ version: row.version + 1, settings });
    });
  }
  async function enqueue(input: unknown, actor: string, queue: AdminQueue) {
    const parsed = marketAdminRefreshSchema.safeParse(input);
    if (!parsed.success) throw new DomainError('MARKET_QUERY_INVALID');
    return transaction(async (client) => {
      // Serialize manual requests with settings changes; queue insertion and audit commit together.
      const selected = await client.query<{ settings: unknown }>(
        'select settings from market_admin_settings where id=1 for update',
      );
      const settings = marketAdminSettingsSchema.parse(
        selected.rows[0]?.settings,
      );
      if (settings.collectionsPaused)
        throw new DomainError('MARKET_COLLECTION_PAUSED');
      if (!settings.manualRefreshEnabled)
        throw new DomainError('MARKET_ACCESS_BLOCKED');
      if (parsed.data.scope === 'recipe') {
        const recipe = await client.query(
          'select id from recipes where id=$1 and active=true',
          [parsed.data.recipeId],
        );
        if (!recipe.rowCount) throw new DomainError('PERSISTENCE_NOT_FOUND');
      }
      const id = randomUUID();
      const inserted = await client.query(
        `insert into market_admin_runs (id,scope,recipe_id,source,status) values ($1,$2,$3,'manual','queued') on conflict do nothing returning id`,
        [
          id,
          parsed.data.scope,
          parsed.data.scope === 'recipe' ? parsed.data.recipeId : null,
        ],
      );
      if (!inserted.rowCount) return { accepted: false, id: null };
      const db: Db = {
        executeSql: async (text, values) => ({
          rows: (await client.query(text, values)).rows,
        }),
      };
      const jobId = await queue.enqueue(
        { ...parsed.data, source: 'manual' },
        id,
        db,
      );
      if (!jobId) throw new DomainError('REFRESH_ALREADY_RUNNING');
      await audit(client, actor, 'refresh.request', { id, ...parsed.data });
      return { accepted: true, id };
    });
  }
  async function claim(id: string, data: AdminRefreshJob) {
    return transaction(async (client) => {
      const selected = await client.query<{ settings: unknown }>(
        'select settings from market_admin_settings where id=1 for update',
      );
      const settings = marketAdminSettingsSchema.parse(
        selected.rows[0]?.settings,
      );
      const allowed =
        !settings.collectionsPaused &&
        (data.source === 'manual'
          ? settings.manualRefreshEnabled
          : settings.automaticRefreshEnabled &&
            settings.scheduledCollectionEnabled);
      await client.query(
        `insert into market_admin_runs (id,scope,recipe_id,source,status) values ($1,$2,$3,$4,'queued') on conflict do nothing`,
        [
          id,
          data.scope,
          data.scope === 'recipe' ? data.recipeId : null,
          data.source,
        ],
      );
      if (!allowed) {
        await client.query(
          `update market_admin_runs set status='skipped',finished_at=now(),error_code='MARKET_COLLECTION_PAUSED' where id=$1 and status='queued'`,
          [id],
        );
        return false;
      }
      await client.query(
        `update market_admin_runs set status='cancelled',finished_at=now(),error_code='MARKET_COLLECTION_CANCELLED' where id=$1 and status='queued' and cancel_requested`,
        [id],
      );
      const result = await client.query(
        `update market_admin_runs set status='running',started_at=now() where id=$1 and status='queued' and not cancel_requested returning id`,
        [id],
      );
      return Boolean(result.rowCount);
    });
  }
  async function finish(
    id: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    errorCode: string | null = null,
  ) {
    await pool.query(
      `update market_admin_runs set status=$2,error_code=$3,finished_at=now() where id=$1 and status in ('queued','running')`,
      [id, status, errorCode],
    );
  }
  async function cancellationRequested(id: string) {
    const result = await pool.query<{
      cancel_requested: boolean;
      status: string;
    }>('select cancel_requested,status from market_admin_runs where id=$1', [
      id,
    ]);
    return (
      !result.rows[0] ||
      result.rows[0].cancel_requested ||
      result.rows[0].status !== 'running'
    );
  }
  async function cancel(id: string, actor: string, queue: AdminQueue) {
    const run = await transaction(async (client) => {
      const result = await client.query<{ status: string }>(
        `update market_admin_runs set cancel_requested=true where id=$1 and status in ('queued','running') returning status`,
        [id],
      );
      if (!result.rows[0])
        throw new DomainError('MARKET_COLLECTION_NOT_RUNNING');
      await audit(client, actor, 'refresh.cancel', { id });
      return result.rows[0];
    });
    if (run.status === 'queued') {
      await queue.cancel(id);
      await finish(id, 'cancelled', 'MARKET_COLLECTION_CANCELLED');
    }
    return { requested: true };
  }
  async function runs() {
    const result =
      await pool.query(`select r.id,r.scope,r.recipe_id as "recipeId",r.source,r.status,
      r.requested_at as "requestedAt",r.started_at as "startedAt",r.finished_at as "finishedAt",
      r.cancel_requested as "cancelRequested",r.error_code as "errorCode",
      extract(epoch from (coalesce(r.finished_at,now())-r.started_at))*1000 as "durationMs",
      coalesce(c.completed_queries,(r.progress->>'succeeded')::int,0) as "completedQueries",coalesce(c.failed_queries,(r.progress->>'failed')::int,0) as "failedQueries",coalesce(c.total_queries,(r.progress->>'total')::int,0) as "totalQueries",
      coalesce((select max(s.captured_at) from raw_snapshots s where s.refresh_cycle_id=r.id),(r.progress->>'sourceFreshness')::timestamptz) as "sourceFreshness",
      r.progress->>'cooldownUntil' as "cooldownUntil"
      from market_admin_runs r left join refresh_cycles c on c.id=r.id order by r.requested_at desc limit 50`);
    return result.rows.map((row) =>
      marketAdminRunSchema.parse({
        ...row,
        requestedAt: row.requestedAt.toISOString(),
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        durationMs: row.durationMs === null ? null : Number(row.durationMs),
        sourceFreshness: row.sourceFreshness?.toISOString() ?? null,
      }),
    );
  }
  async function progress(id: string, report: Record<string, unknown>) {
    await pool.query(
      `update market_admin_runs set progress=$2::jsonb where id=$1 and status='running'`,
      [id, JSON.stringify(report)],
    );
  }
  async function heartbeat(version: number) {
    await pool.query(
      `insert into market_worker_health (id,heartbeat_at,settings_version) values ('catalog',now(),$1) on conflict(id) do update set heartbeat_at=now(),settings_version=excluded.settings_version`,
      [version],
    );
  }
  async function workerHealth() {
    const result = await pool.query<{
      heartbeat_at: Date;
      settings_version: number;
    }>(
      `select heartbeat_at,settings_version from market_worker_health where id='catalog'`,
    );
    const row = result.rows[0];
    return {
      healthy: Boolean(row && Date.now() - row.heartbeat_at.getTime() < 20_000),
      heartbeatAt: row?.heartbeat_at.toISOString() ?? null,
      settingsVersion: row?.settings_version ?? null,
    };
  }
  async function failCycle(id: string, code: string) {
    await transaction(async (client) => {
      await client.query(
        `update jobs set status='failed',last_error=$2,locked_at=null,locked_by=null,updated_at=now() where refresh_cycle_id=$1 and status in ('queued','running','retry')`,
        [id, code],
      );
      await client.query(
        `update refresh_cycles set status='failed',finished_at=now(),updated_at=now(),error_message=$2 where id=$1 and status in ('queued','running')`,
        [id, code],
      );
    });
  }
  async function reconcile(queue: {
    state(id: string): Promise<string | null>;
    cancel(id: string): Promise<unknown>;
  }) {
    const records = await pool.query<{
      id: string;
      status: string;
      requested_at: Date;
    }>(
      `select id,status,requested_at from market_admin_runs where status in ('queued','running')`,
    );
    for (const run of records.rows) {
      const state = await queue.state(run.id);
      const expired =
        run.status === 'queued' &&
        Date.now() - run.requested_at.getTime() > 60 * 60_000;
      if (expired) {
        const pending = await pool.query(
          `update market_admin_runs set status='failed',finished_at=now(),error_code='REFRESH_QUEUE_EXPIRED' where id=$1 and status='queued' returning id`,
          [run.id],
        );
        if (!pending.rowCount) continue;
        await queue.cancel(run.id);
      }
      if (
        expired ||
        !state ||
        !['created', 'retry', 'active'].includes(state)
      ) {
        await failCycle(
          run.id,
          expired ? 'REFRESH_QUEUE_EXPIRED' : 'REFRESH_WORKER_INTERRUPTED',
        );
        await finish(
          run.id,
          'failed',
          expired ? 'REFRESH_QUEUE_EXPIRED' : 'REFRESH_WORKER_INTERRUPTED',
        );
      }
    }
    const cycles = await pool.query<{ id: string }>(
      `select id from refresh_cycles where status in ('queued','running') limit 100`,
    );
    for (const cycle of cycles.rows) {
      const state = await queue.state(cycle.id);
      if (!state || !['created', 'retry', 'active'].includes(state))
        await failCycle(cycle.id, 'REFRESH_WORKER_INTERRUPTED');
    }
  }
  async function cleanupObservations(settings: MarketAdminSettings) {
    const rawBefore = new Date(
      Date.now() - settings.rawRetentionHours * 3_600_000,
    );
    const historyBefore = new Date(
      Date.now() - settings.historyRetentionDays * 86_400_000,
    );
    return transaction(async (client) => {
      const raw = await client.query(
        `update market_research_snapshots set listings='[]'::jsonb,summary=jsonb_set(summary,'{rawAvailable}','false'::jsonb) where captured_at<$1 and coalesce(summary->>'rawAvailable','true')='true'`,
        [rawBefore],
      );
      await client.query(
        `update market_collection_runs set payload=jsonb_set(jsonb_set(payload-'searchEvidence','{listings}','[]'::jsonb),'{rawAvailable}','false'::jsonb) where completed_at<$1 and status<>'running' and payload->>'snapshotId' is not null and coalesce(payload->>'rawAvailable','true')='true'`,
        [rawBefore],
      );
      const history = await client.query(
        'delete from market_research_snapshots where captured_at<$1',
        [historyBefore],
      );
      await client.query(
        `delete from market_collection_runs where completed_at<$1 and status<>'running' and payload->>'snapshotId' is not null`,
        [historyBefore],
      );
      await audit(client, 'worker', 'retention.cleanup', {
        rawSnapshots: raw.rowCount,
        summaries: history.rowCount,
        rawBefore: rawBefore.toISOString(),
        historyBefore: historyBefore.toISOString(),
      });
      return { rawSnapshots: raw.rowCount, summaries: history.rowCount };
    });
  }
  return {
    init,
    read,
    patch,
    enqueue,
    claim,
    finish,
    runs,
    cancel,
    cancellationRequested,
    heartbeat,
    workerHealth,
    failCycle,
    reconcile,
    cleanupObservations,
    progress,
    audit: (actor: string, action: string, details: Record<string, unknown>) =>
      audit(pool, actor, action, details),
  };
}
export type MarketAdminStore = ReturnType<typeof createMarketAdminStore>;
