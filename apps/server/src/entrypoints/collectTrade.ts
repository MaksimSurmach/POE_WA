import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { DomainError } from '@poe-worksmith/domain';
import { marketAdminSettingsSchema } from '@poe-worksmith/contracts';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { MarketCollectionManager } from '../marketCollection.js';
import { configuredCollectionSource } from '../marketCollectionSource.js';
import { GggRateLimitController } from '../rateLimitController.js';
import { createPostgresRepositories } from '../repositories/index.js';
import { clearTradeAuthenticationDenials } from '../repositories/postgresRepositories.js';
import { createMarketCollectionRepository } from '../repositories/marketCollectionRepository.js';
import { createMarketEconomyRepository } from '../repositories/marketEconomyRepository.js';
import { createTradeSessionRepository } from '../repositories/tradeSessionRepository.js';

async function main() {
  const [command, targetId] = process.argv.slice(2);
  if (
    command !== 'store-session' &&
    (!['collect', 'serve'].includes(command ?? '') ||
      !z.uuid().safeParse(targetId).success)
  ) {
    console.error(
      'Usage: market:trade store-session | collect <target-id> | serve <target-id>',
    );
    process.exitCode = 2;
    return;
  }

  const pool = createDatabasePool(
    { ...loadDatabaseConfig(), maxConnections: 3 },
    undefined,
    15_000,
  );
  try {
    if (command === 'serve')
      return await runCommand(command, targetId, pool, pool);
    await withTradeLock(pool, (client) =>
      runCommand(command, targetId, pool, client),
    );
    if (command === 'store-session')
      console.log(JSON.stringify({ status: 'session_stored' }));
  } finally {
    await pool.end();
  }
}

async function withTradeLock<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
) {
  const lock = await pool.connect();
  try {
    await lock.query('begin');
    const lease = await lock.query<{ acquired: boolean }>(
      "select pg_try_advisory_xact_lock(hashtext('poe-worksmith:trade-collection')) as acquired",
    );
    if (!lease.rows[0]?.acquired)
      throw new DomainError('MARKET_COLLECTION_BUSY');
    const result = await work(lock);
    await lock.query('commit');
    return result;
  } finally {
    lock.release(true);
  }
}

async function runCommand(
  command: string | undefined,
  targetId: string | undefined,
  pool: Pool,
  client: Pick<Pool, 'query'>,
) {
  const sessions = createTradeSessionRepository(
    client,
    process.env.POE_TRADE_SESSION_KEY,
  );
  if (command === 'store-session') {
    const session = readFileSync(0, 'utf8').trim();
    const previous = await sessions.read().catch((error: unknown) => {
      if (
        error instanceof Error &&
        error.message === 'TRADE_SESSION_DECRYPT_FAILED'
      )
        return null;
      throw error;
    });
    await sessions.save(session);
    if (previous !== session)
      await clearTradeAuthenticationDenials(client, new Date());
    return;
  }
  if (process.env.POE_TRADE_ACCESS !== 'owner_permitted')
    throw new DomainError('MARKET_ACCESS_BLOCKED');
  const session = await sessions.read();
  if (!session) throw new DomainError('PROVIDER_AUTH_FAILED');

  async function readSettings() {
    const result = await pool.query<{ settings: unknown }>(
      'select settings from market_admin_settings where id=1',
    );
    return marketAdminSettingsSchema.parse(result.rows[0]?.settings);
  }

  const rateLimits = new GggRateLimitController({
    repository: createPostgresRepositories(pool).rateLimits,
  });
  const makeAdapter = (sessionId: string) =>
    configuredCollectionSource(
      rateLimits,
      {
        MARKET_COLLECTION_SOURCE: 'trade-compatible',
        POE_TRADE_ACCESS: 'owner_permitted',
        POE_TRADE_BASE_URL: 'https://www.pathofexile.com',
        POE_TRADE_SESSION_ID: sessionId,
        POE_TRADE_USER_AGENT: process.env.POE_TRADE_USER_AGENT,
      },
      createMarketEconomyRepository(pool),
      async () => (await readSettings()).requestTimeoutMs,
    );
  const adapter = makeAdapter(session);
  if (!targetId) throw new DomainError('MARKET_TARGET_NOT_FOUND');
  const store = createMarketCollectionRepository(pool);
  if (command === 'serve') {
    const manager = new MarketCollectionManager({
      adapter: {
        ...adapter,
        collect: (input) =>
          withTradeLock(pool, async (locked) => {
            const current = await createTradeSessionRepository(
              locked,
              process.env.POE_TRADE_SESSION_KEY,
            ).read();
            if (!current) throw new DomainError('PROVIDER_AUTH_FAILED');
            const source = makeAdapter(current);
            try {
              return await source.collect({
                ...input,
                signal: AbortSignal.any([
                  input.signal,
                  AbortSignal.timeout(4 * 60_000),
                ]),
              });
            } finally {
              await source.close();
            }
          }),
      },
      store: {
        ...store,
        async listSettings() {
          const settings = await store.findSettings(targetId);
          return settings ? [settings] : [];
        },
        recoverRunningRuns: (at, ids) =>
          store.recoverRunningRuns(at, ids, targetId),
        async saveRun(run) {
          const saved = await store.saveRun(run);
          if (saved.status !== 'running')
            console.log(
              JSON.stringify({
                event: 'trade_run',
                runId: saved.id,
                targetId,
                status: saved.status,
                coverage: saved.coverage,
                listingCount: saved.listingCount,
                snapshotId: saved.snapshotId,
                errorCode: saved.errorCode,
              }),
            );
          return saved;
        },
      },
      readControls: async () => ({
        collectionsPaused: (await readSettings()).collectionsPaused,
        scheduledCollectionEnabled: true,
        automaticRefreshEnabled: true,
        collectionConcurrency: 1,
      }),
    });
    const stop = new AbortController();
    const abort = () => stop.abort();
    process.once('SIGTERM', abort);
    process.once('SIGINT', abort);
    try {
      console.log(JSON.stringify({ event: 'trade_scraper_started', targetId }));
      await manager.start(30_000, (error) =>
        console.error(
          JSON.stringify({
            event: 'trade_scheduler_error',
            errorCode:
              error instanceof DomainError ? error.code : 'MARKET_TICK_FAILED',
          }),
        ),
      );
      if (!stop.signal.aborted) await once(stop.signal, 'abort');
    } finally {
      process.off('SIGTERM', abort);
      process.off('SIGINT', abort);
      await manager.stop();
      await adapter.close();
    }
    return;
  }
  const settings = await readSettings();
  if (settings.collectionsPaused || !settings.manualRefreshEnabled)
    throw new DomainError('MARKET_COLLECTION_PAUSED');
  await store.recoverRunningRuns(new Date().toISOString(), [], targetId);
  const manager = new MarketCollectionManager({ adapter, store });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const run = await manager.collectNow(
      targetId,
      AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
    );
    console.log(
      JSON.stringify({
        runId: run.id,
        targetId: run.targetId,
        status: run.status,
        coverage: run.coverage,
        listingCount: run.listingCount,
        snapshotId: run.snapshotId,
        errorCode: run.errorCode,
      }),
    );
    if (
      !run.snapshotId ||
      run.status !== 'succeeded' ||
      run.coverage !== 'complete'
    )
      process.exitCode = 1;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await manager.stop();
    await adapter.close();
  }
}

main().catch((error: unknown) => {
  const errorCode =
    error instanceof DomainError
      ? error.code
      : error instanceof Error && /^TRADE_SESSION_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'MARKET_TRADE_COMMAND_FAILED';
  console.error(JSON.stringify({ errorCode }));
  process.exitCode = 1;
});
