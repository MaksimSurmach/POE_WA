import { collectRecipeMaterialPrices } from './marketEconomy.js';
import { synchronizeRecipeCatalog } from './recipes/synchronizeRecipes.js';
import { existsSync } from 'node:fs';
import pino from 'pino';
import { fileURLToPath } from 'node:url';

import { buildApi } from './api.js';
import { ProviderCircuitBreaker } from './circuitBreaker.js';
import { createDatabasePool } from './database.js';
import {
  ApplicationJobScheduler,
  createJobBoss,
  ManualRefreshProducer,
} from './jobs.js';
import {
  HttpPoeNinjaLeagueClient,
  HttpPoeTradeLeagueClient,
  LeagueResolver,
} from './leagues.js';
import { MarketJobProcessor } from './marketJobProcessor.js';
import { PoeTradeClient } from './providers/poeTrade.js';
import { GggRateLimitController } from './rateLimitController.js';
import { FullRefreshOrchestrator } from './refreshOrchestrator.js';
import { refreshLeagueContext } from './refreshLeagueContext.js';
import { createRecipeMarketDependencies } from './recipeMarket.js';
import { createPostgresRepositories } from './repositories/index.js';
import {
  createPostgresResourceResolver,
  createPostgresTradeMappingCatalog,
} from './tradeMappings.js';
import {
  clusterJewelVariantFilter,
  mappedTargetFilter,
  noVariantFilter,
  RegisteredTradeQueryGenerator,
} from '@poe-worksmith/domain';
import { RetentionCleaner } from './retention.js';
import { createResourceReaders } from './resourceViews.js';
import { loadItemPresentationCatalog } from './itemPresentation.js';
import { ApplicationRuntime } from './runtime.js';
import {
  type ApplicationMode,
  loadRuntimeConfig,
  modeIncludesApi,
  modeIncludesWorker,
} from './runtimeConfig.js';
import { Metrics } from './observability/metrics.js';
import { createRefreshFreshnessReader } from './freshness.js';
import { createMarketResearchRepository } from './repositories/marketResearchRepository.js';
import { createMarketEconomyRepository } from './repositories/marketEconomyRepository.js';
import { createMarketCollectionRepository } from './repositories/marketCollectionRepository.js';
import { NinjaEconomyClient } from './providers/ninjaEconomy.js';
import { MarketCollectionManager } from './marketCollection.js';
import {
  configuredCollectionSource,
  managedCollectionSource,
} from './marketCollectionSource.js';

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
  let workerError: Error | undefined;
  const repositories = createPostgresRepositories(pool);
  const economy = createMarketEconomyRepository(pool);
  const economyClient = new NinjaEconomyClient({
    userAgent: process.env.NINJA_USER_AGENT ?? config.poeUserAgent,
  });
  const recipeRoot = fileURLToPath(
    new URL('../../../recipes/', import.meta.url),
  );
  const catalogPath = existsSync(recipeRoot)
    ? recipeRoot
    : fileURLToPath(new URL('../recipes/', import.meta.url));
  const sync = await synchronizeRecipeCatalog(
    catalogPath,
    repositories.recipes,
  );
  if (sync.failed.length) throw new Error('RECIPE_SYNC_FAILED');
  const trade = new RegisteredTradeQueryGenerator(
    createPostgresTradeMappingCatalog(pool),
    [noVariantFilter, clusterJewelVariantFilter],
    [mappedTargetFilter],
  );
  const marketDependencies = createRecipeMarketDependencies({
    resolveResource: createPostgresResourceResolver(pool),
    trade,
  });
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
  );
  let jobs: ApplicationJobScheduler | undefined;
  let tradeClient: PoeTradeClient | undefined;
  const refreshProducer =
    modeIncludesApi(config.mode) && !modeIncludesWorker(config.mode)
      ? new ManualRefreshProducer(
          createJobBoss(pool, config.jobSchema, logger, (error) => {
            workerError ??= error;
          }),
        )
      : undefined;
  const research = createMarketResearchRepository(pool);
  const collectionStore = createMarketCollectionRepository(pool);
  const collectionManager = new MarketCollectionManager({
    adapter: configuredCollectionSource(
      new GggRateLimitController({ repository: repositories.rateLimits }),
      process.env,
      economy,
    ),
    store: collectionStore,
  });
  const api = modeIncludesApi(config.mode)
    ? buildApi(
        logger,
        async () => {
          await pool.query('select 1');
          if (workerError) throw workerError;
        },
        repositories.catalog.getProgress,
        repositories.rateLimits.list,
        resourceReaders.readCatalog,
        resourceReaders.readRecipe,
        repositories.leagues.list,
        repositories.leagues.findCurrent,
        {
          diagnosticsToken: config.operatorDiagnosticsToken,
          metrics: metrics.registry,
          marketResearch: research,
          marketCollection:
            collectionStore && collectionManager
              ? { manager: collectionManager, store: collectionStore }
              : undefined,
          marketEconomy: {
            repository: economy,
            client: process.env.NINJA_USER_AGENT
              ? new NinjaEconomyClient({
                  userAgent: process.env.NINJA_USER_AGENT,
                })
              : undefined,
          },
          readCircuits: repositories.providerCircuits.list,
          readOperationalDiagnostics: repositories.operationalDiagnostics.read,
          readRefreshFreshness: createRefreshFreshnessReader({
            cron: config.refreshCron,
            findLatestAttempt: repositories.cycles.findLatestAttempt,
            getProgress: repositories.catalog.getProgress,
            timezone: config.refreshTimezone,
          }),
          triggerRefresh: modeIncludesWorker(config.mode)
            ? async () => {
                if (!jobs) throw new Error('REFRESH_WORKER_UNAVAILABLE');
                return jobs.triggerRefresh();
              }
            : refreshProducer
              ? () => refreshProducer.triggerRefresh()
              : undefined,
        },
      )
    : undefined;
  if (modeIncludesWorker(config.mode)) {
    const rateLimits = new GggRateLimitController({
      repository: repositories.rateLimits,
    });
    const circuits = new ProviderCircuitBreaker({
      provider: 'poe-trade',
      repository: repositories.providerCircuits,
    });
    tradeClient = new PoeTradeClient({
      allowRequests: process.env.POE_TRADE_ACCESS === 'owner_permitted',
      collectionTimeoutMs: Math.min(
        15 * 60_000,
        Math.max(1000, config.jobLeaseTimeoutMs - 1000),
      ),
      collectionSource: managedCollectionSource(collectionManager, research),
      circuits,
      logger,
      metrics,
      rateLimits,
      requestTimeoutMs: config.poeRequestTimeoutMs,
      userAgent: config.poeUserAgent,
    });
    const marketJobs = new MarketJobProcessor({
      concurrency: config.marketConcurrency,
      leaseTimeoutMs: config.jobLeaseTimeoutMs,
      logger,
      metrics,
      providers: [tradeClient],
      repositories,
      retryDelayMs: config.marketRetryDelayMs,
      snapshotTtlMs: config.snapshotTtlMs,
    });
    const retention = new RetentionCleaner({
      batchSize: config.retentionBatchSize,
      repositories,
    });
    const resolver = new LeagueResolver({
      leagues: repositories.leagues,
      poeNinja: new HttpPoeNinjaLeagueClient({
        requestTimeoutMs: config.poeRequestTimeoutMs,
        userAgent: config.poeUserAgent,
      }),
      trade: new HttpPoeTradeLeagueClient({
        requestTimeoutMs: config.poeRequestTimeoutMs,
        userAgent: config.poeUserAgent,
      }),
    });
    jobs = new ApplicationJobScheduler({
      boss: createJobBoss(pool, config.jobSchema, logger, (error) => {
        workerError ??= error;
      }),
      cleanupCron: config.cleanupCron,
      logger,
      refreshCron: config.refreshCron,
      refreshTimezone: config.refreshTimezone,
      runCleanup: () => retention.run(),
      runRefresh: async (cycleId) => {
        const currentLeague = await repositories.leagues.findCurrent();
        if (!currentLeague) throw new Error('CURRENT_LEAGUE_UNRESOLVED');
        return new FullRefreshOrchestrator({
          collectMaterialPrices: () =>
            collectRecipeMaterialPrices(
              currentLeague.gggId,
              economyClient,
              economy,
            ),
          league: refreshLeagueContext(currentLeague),
          marketJobs,
          marketDependencies,
          economy,
          repositories,
          logger,
          metrics,
          snapshotTtlMs: config.snapshotTtlMs,
          workerId: `worker-${process.pid}`,
        }).run(cycleId);
      },
      leagueCron: config.leagueResolveCron,
      leagueTimezone: config.leagueResolveTimezone,
      runLeagueResolve: () => resolver.resolve(),
    });
  }
  const runtime = new ApplicationRuntime({
    ...(api ? { api } : {}),
    ...(refreshProducer ? { apiJobs: refreshProducer } : {}),
    afterApiClose: async () => {
      tradeClient?.stop();
      await collectionManager?.stop();
    },
    host: config.host,
    ...(jobs ? { jobs } : {}),
    logger,
    mode: config.mode,
    pool,
    port: config.port,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  });

  try {
    await runtime.start();
  } catch (error) {
    logger.fatal({ err: error }, 'application startup failed');
    await collectionManager?.stop().catch((cleanupError: unknown) => {
      logger.error({ err: cleanupError }, 'market collection cleanup failed');
    });
    await runtime.stop().catch((cleanupError: unknown) => {
      logger.error({ err: cleanupError }, 'application startup cleanup failed');
    });
    process.exitCode = 1;
    return;
  }

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
}
