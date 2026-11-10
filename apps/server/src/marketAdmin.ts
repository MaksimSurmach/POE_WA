import { CronExpressionParser } from 'cron-parser';
import type { Pool, PoolClient } from 'pg';
import {
  marketAdminSettingsSchema,
  storedMarketAdminSettingsSchema,
  marketAdminPatchSchema,
  type MarketAdminSettings,
} from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';

export function scheduledRefreshEnabled(settings: MarketAdminSettings) {
  return (
    settings.automaticRefreshEnabled &&
    settings.scheduledCollectionEnabled &&
    !settings.collectionsPaused
  );
}

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
    const configured = storedMarketAdminSettingsSchema.parse(row.settings);
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
      const previous = storedMarketAdminSettingsSchema.parse(row.settings);
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
      if (previous.collectionsPaused !== settings.collectionsPaused)
        await client.query("select pg_notify('worksmith_wake', '')");
      return response({ version: row.version + 1, settings });
    });
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
    cleanupObservations,
    audit: (actor: string, action: string, details: Record<string, unknown>) =>
      audit(pool, actor, action, details),
  };
}
export type MarketAdminStore = ReturnType<typeof createMarketAdminStore>;
