import { createFactoryService } from './factory.js';
import { createFactoryRepository } from './repositories/factoryRepository.js';
import { createCraftAnalysisService } from './craftAnalysis.js';
import { createCraftAnalysisRepository } from './repositories/craftAnalysisRepository.js';
import { collectRecipeMaterialPrices } from './marketEconomy.js';
import {
  createMarketAdminStore,
  defaultAdminSettings,
  scheduledRefreshEnabled,
} from './marketAdmin.js';
import { DomainError } from '@poe-worksmith/domain';
import {
  synchronizeCollectorSchedules,
  synchronizeRecipeCatalog,
} from './recipes/synchronizeRecipes.js';
import { runCollector } from './collector.js';
import {
  createCollectorEconomyCache,
  createCollectorResultPublisher,
  createCollectorResultReader,
} from './collectorResults.js';
import { configuredTradeCapture } from './collectorTrade.js';
import { createMarketActivityReader } from './marketActivity.js';
import { existsSync } from 'node:fs';
import pino from 'pino';
import type { PoolClient } from 'pg';
import { fileURLToPath } from 'node:url';

import { buildApi } from './api.js';
import { createDatabasePool } from './database.js';
import { createGameDataRepository } from './gameData.js';
import { HttpPoeTradeLeagueClient, LeagueResolver } from './leagues.js';
import { GggRateLimitController } from './rateLimitController.js';
import { createPostgresRepositories } from './repositories/index.js';
import { createTradeSessionRepository } from './repositories/tradeSessionRepository.js';
import { createPostgresTradeMappingCatalog } from './tradeMappings.js';
import {
  clusterJewelVariantFilter,
  mappedTargetFilter,
  noVariantFilter,
  RegisteredTradeQueryGenerator,
} from '@poe-worksmith/domain';
import { RetentionCleaner } from './retention.js';
import { createResourceReaders } from './resourceViews.js';
import { loadItemPresentationCatalog } from './itemPresentation.js';
import { ApplicationRuntime, runCollectorRuntime } from './runtime.js';
import { type ApplicationMode, loadRuntimeConfig } from './runtimeConfig.js';
import { Metrics } from './observability/metrics.js';
import { createRefreshFreshnessReader } from './freshness.js';
import { createMarketResearchRepository } from './repositories/marketResearchRepository.js';
import { createMarketEconomyRepository } from './repositories/marketEconomyRepository.js';
import { createPriceHistoryRepository } from './repositories/priceHistoryRepository.js';
import { createMarketTrendsReader } from './marketTrendsApi.js';
import {
  NinjaEconomyClient,
  NinjaEconomyError,
} from './providers/ninjaEconomy.js';

export async function runProcess(forcedMode?: ApplicationMode) {
  const config = loadRuntimeConfig(process.env, forcedMode);
  const logger = pino({
    level: config.logLevel,
    name: 'poe-worksmith',
    redact: {
      censor: '[Redacted]',
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers.set-cookie',
        'password',
        'token',
        'accessToken',
        'refreshToken',
        'payload',
        'providerPayload',
        'query',
      ],
    },
  });
  const metrics = new Metrics();
  const pool = createDatabasePool(config.database, logger);
  const repositories = createPostgresRepositories(pool);
  const gameData = createGameDataRepository(pool);
  const economy = createMarketEconomyRepository(pool);
  const priceHistory = createPriceHistoryRepository(pool);
  const admin = createMarketAdminStore({
    pool,
    defaults: defaultAdminSettings({
      refreshCron: config.refreshCron,
      requestTimeoutMs: Number(
        process.env.POE_TRADE_REQUEST_TIMEOUT_MS ?? config.poeRequestTimeoutMs,
      ),
      concurrency: config.marketConcurrency,
      snapshotTtlMs: config.snapshotTtlMs,
    }),
    timezone: config.refreshTimezone,
    concurrencyLimit: config.marketConcurrency,
  });
  await admin.init();
  async function readSchedule() {
    const { effective, timezone } = await admin.read();
    return {
      enabled: scheduledRefreshEnabled(effective),
      cron: effective.refreshCron,
      timezone,
    };
  }
  const economyClient = new NinjaEconomyClient({
    userAgent: process.env.NINJA_USER_AGENT ?? config.poeUserAgent,
    cooldowns: repositories.providerCircuits,
    readTimeoutMs: async () => (await admin.read()).effective.requestTimeoutMs,
  });
  const createLeagueResolver = (client?: PoolClient) =>
    new LeagueResolver({
      leagues: client
        ? createPostgresRepositories(pool, client).leagues
        : repositories.leagues,
      poeNinja: {
        async fetchEconomyLeagues() {
          try {
            return (await economyClient.discoverLeagues()).snapshot.leagues;
          } catch (cause) {
            throw new DomainError(
              cause instanceof NinjaEconomyError &&
                cause.code === 'SCHEMA_INVALID'
                ? 'POE_NINJA_LEAGUES_INVALID'
                : 'POE_NINJA_LEAGUES_UNAVAILABLE',
              { cause },
            );
          }
        },
      },
      trade: new HttpPoeTradeLeagueClient({
        requestTimeoutMs: config.poeRequestTimeoutMs,
        userAgent: config.poeUserAgent,
      }),
    });
  const runCleanup = async (signal?: AbortSignal) => {
    const settings = (await admin.read()).effective;
    signal?.throwIfAborted();
    await admin.cleanupObservations(settings);
    signal?.throwIfAborted();
    await economy.cleanup?.({
      payloadBefore: new Date(
        Date.now() - settings.rawRetentionHours * 3_600_000,
      ),
      snapshotsBefore: new Date(
        Date.now() - settings.historyRetentionDays * 86_400_000,
      ),
    });
    signal?.throwIfAborted();
    // Rollup moves old observations into daily summaries before deleting them.
    await priceHistory.compact({
      batchSize: config.retentionBatchSize,
      dailyRetentionDays: settings.historyRetentionDays,
    });
    signal?.throwIfAborted();
    return new RetentionCleaner({
      batchSize: config.retentionBatchSize,
      repositories,
      rawSnapshotsRetentionMs: settings.rawRetentionHours * 3_600_000,
      observationsRetentionMs: settings.historyRetentionDays * 86_400_000,
    }).run();
  };
  const recipeRoot = fileURLToPath(
    new URL('../../../recipes/', import.meta.url),
  );
  const catalogPath = existsSync(recipeRoot)
    ? recipeRoot
    : fileURLToPath(new URL('../recipes/', import.meta.url));
  if (config.mode === 'collector') {
    // Reserve a session for leadership even when the provider pool allows one connection.
    const leaderPool = createDatabasePool(
      { ...config.database, maxConnections: 1 },
      logger,
    );
    try {
      const rateLimits = new GggRateLimitController({
        repository: repositories.rateLimits,
      });
      const readEconomySnapshot = createCollectorEconomyCache();
      const trade = configuredTradeCapture(
        rateLimits,
        {
          latest: economy.latest,
          find: (id) => readEconomySnapshot(economy, id),
        },
        process.env,
      );
      const sessionKey = process.env.POE_TRADE_SESSION_KEY;
      await runCollectorRuntime(
        (signal) =>
          runCollector({
            pool: leaderPool,
            signal,
            publishResults: createCollectorResultPublisher(
              pool,
              async () => (await admin.read()).effective,
              readEconomySnapshot,
            ),
            onError: (code) =>
              logger.warn({ code }, 'collector operation will retry'),
            onLeaderAcquired: async (client) => {
              await client.query(
                "update collector_schedule set enabled = $1 where kind = 'retention' and key = 'retention' and enabled <> $1",
                [config.collectorRetentionEnabled],
              );
              logger.info('leader acquired');
            },
            bootstrap: async (client, jobSignal) => {
              const pinned = createPostgresRepositories(pool, client);
              const report = await synchronizeRecipeCatalog(
                catalogPath,
                pinned.recipes,
                { gameData: await gameData.openActive() },
              );
              if (report.failed.length) throw new Error('RECIPE_SYNC_FAILED');
              jobSignal.throwIfAborted();
              if (!(await pinned.leagues.findCurrent()))
                await createLeagueResolver(client).resolve();
              jobSignal.throwIfAborted();
              const sync = await synchronizeCollectorSchedules(
                pool,
                config,
                new Date(),
                client,
              );
              if (sync !== 'synchronized')
                throw new Error('COLLECTOR_SCHEDULE_SYNC_UNAVAILABLE');
            },
            handlers: {
              'trade-target': (
                schedule,
                jobSignal,
                client,
                recoverAuthentication,
              ) =>
                trade(schedule, jobSignal, {
                  sessions: () =>
                    createTradeSessionRepository(client, sessionKey),
                  recoverAuthentication,
                }),
              economy: async ({ payload }, jobSignal, client) => {
                const { league } = payload;
                if (typeof league !== 'string' || !league.trim())
                  return {
                    status: 'retry',
                    reason: 'COLLECTOR_ECONOMY_LEAGUE_INVALID',
                  };
                const report = await collectRecipeMaterialPrices(
                  league,
                  economyClient,
                  createMarketEconomyRepository(client),
                  jobSignal,
                );
                return report.failed
                  ? {
                      status: 'retry',
                      economyUpdated: report.succeeded > 0,
                      reason: report.errorCode ?? 'ECONOMY_UNAVAILABLE',
                      ...(report.cooldownUntil
                        ? { retryAt: new Date(report.cooldownUntil) }
                        : {}),
                    }
                  : { status: 'success' };
              },
              league: async (_, jobSignal, client) => {
                await createLeagueResolver(client).resolve();
                jobSignal.throwIfAborted();
                const sync = await synchronizeCollectorSchedules(
                  pool,
                  config,
                  new Date(),
                  client,
                );
                return sync === 'synchronized'
                  ? { status: 'success' }
                  : {
                      status: 'retry',
                      reason: 'COLLECTOR_SCHEDULE_SYNC_UNAVAILABLE',
                    };
              },
              retention: async (_, jobSignal) => {
                if (!config.collectorRetentionEnabled)
                  return {
                    status: 'blocked',
                    reason: 'COLLECTOR_RETENTION_DISABLED',
                  };
                await runCleanup(jobSignal);
                return { status: 'success' };
              },
            },
          }),
        logger,
      );
    } finally {
      await Promise.all([leaderPool.end(), pool.end()]);
    }
    return;
  }
  const sync = await synchronizeRecipeCatalog(
    catalogPath,
    repositories.recipes,
    { gameData: await gameData.openActive() },
  );
  if (sync.failed.length) throw new Error('RECIPE_SYNC_FAILED');
  const trade = new RegisteredTradeQueryGenerator(
    createPostgresTradeMappingCatalog(pool),
    [noVariantFilter, clusterJewelVariantFilter],
    [mappedTargetFilter],
  );
  const presentationCatalog = await loadItemPresentationCatalog(
    fileURLToPath(
      new URL(
        '../presentation/poe1/3.29.3.3/physical-large-cluster.json',
        import.meta.url,
      ),
    ),
  );
  const resourceReaders = createResourceReaders(
    repositories,
    presentationCatalog,
    trade,
    async () => (await admin.read()).effective.maximumQuoteAgeMs,
    config.pipeline === 'collector'
      ? createCollectorResultReader(pool)
      : undefined,
    config.pipeline === 'collector'
      ? createMarketActivityReader(pool)
      : undefined,
  );
  const research = createMarketResearchRepository(pool);
  const craftAnalysis = createCraftAnalysisService({
    repository: createCraftAnalysisRepository(pool, config.pipeline),
    onWorkerError: (error) =>
      logger.warn(
        { err: error },
        'Craft risk worker failed; queued work remains recoverable',
      ),
    recipes: repositories.recipes,
    leagues: repositories.leagues,
    maximumQuoteAgeMs: async () =>
      (await admin.read()).effective.maximumQuoteAgeMs,
  });
  // Legacy worker/all modes are rejected by loadRuntimeConfig, so this is the API.
  const api = buildApi(
    logger,
    async () => {
      await pool.query('select 1');
    },
    repositories.catalog.getProgress,
    repositories.rateLimits.list,
    resourceReaders.readCatalog,
    resourceReaders.readRecipe,
    repositories.leagues.list,
    repositories.leagues.findCurrent,
    {
      craftAnalysis,
      factory: createFactoryService({
        repository: createFactoryRepository(pool),
        analysis: craftAnalysis,
        leagues: repositories.leagues,
      }),
      marketAdmin: { store: admin },
      diagnosticsToken: config.operatorDiagnosticsToken,
      collectorPool: pool,
      metrics: metrics.registry,
      marketResearch: research,
      marketEconomy: {
        repository: economy,
        client: economyClient,
        readRetention: async () => (await admin.read()).effective,
      },
      marketTrends: createMarketTrendsReader({
        history: priceHistory,
        recipes: repositories.recipes,
        findCurrentLeague: repositories.leagues.findCurrent,
      }),
      readCircuits: repositories.providerCircuits.list,
      readOperationalDiagnostics: repositories.operationalDiagnostics.read,
      readRefreshFreshness: createRefreshFreshnessReader({
        readSchedule,
        findLatestAttempt: repositories.cycles.findLatestAttempt,
        getProgress: repositories.catalog.getProgress,
      }),
    },
  );
  const runtime = new ApplicationRuntime({
    api,
    host: config.host,
    logger,
    mode: config.mode,
    pool,
    port: config.port,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutdown requested');
    try {
      await runtime.stop();
    } catch (error) {
      logger.error({ err: error }, 'application shutdown failed');
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await runtime.start();
  } catch (error) {
    logger.fatal({ err: error }, 'application startup failed');
    await runtime.stop().catch((cleanupError: unknown) => {
      logger.error({ err: cleanupError }, 'application startup cleanup failed');
    });
    process.exitCode = 1;
    return;
  }
}
