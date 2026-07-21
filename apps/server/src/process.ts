import pino from 'pino';
import { fileURLToPath } from 'node:url';

import { buildApi } from './api.js';
import { ProviderCircuitBreaker } from './circuitBreaker.js';
import { createDatabasePool } from './database.js';
import { ApplicationJobScheduler, createJobBoss } from './jobs.js';
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
import { createV2RecipeMarketDependencies } from './recipeMarket.js';
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

export async function runProcess(forcedMode?: ApplicationMode) {
  const config = loadRuntimeConfig(process.env, forcedMode);
  const logger = pino({ level: config.logLevel, name: 'poe-worksmith' });
  const pool = createDatabasePool(config.database);
  let workerError: Error | undefined;
  const repositories = createPostgresRepositories(pool);
  const marketDependencies = createV2RecipeMarketDependencies({
    resolveResource: createPostgresResourceResolver(pool),
    trade: new RegisteredTradeQueryGenerator(
      createPostgresTradeMappingCatalog(pool),
      [noVariantFilter, clusterJewelVariantFilter],
      [mappedTargetFilter],
    ),
  });
  const presentationCatalog = await loadItemPresentationCatalog(
    fileURLToPath(
      new URL(
        '../presentation/poe1/3.26.0/physical-large-cluster.json',
        import.meta.url,
      ),
    ),
  );
  const resourceReaders = createResourceReaders(
    repositories,
    presentationCatalog,
  );
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
      )
    : undefined;
  let jobs: ApplicationJobScheduler | undefined;
  if (modeIncludesWorker(config.mode)) {
    const rateLimits = new GggRateLimitController({
      repository: repositories.rateLimits,
    });
    const circuits = new ProviderCircuitBreaker({
      provider: 'poe-trade',
      repository: repositories.providerCircuits,
    });
    const marketJobs = new MarketJobProcessor({
      concurrency: config.marketConcurrency,
      leaseTimeoutMs: config.jobLeaseTimeoutMs,
      providers: [
        new PoeTradeClient({
          circuits,
          rateLimits,
          requestTimeoutMs: config.poeRequestTimeoutMs,
          userAgent: config.poeUserAgent,
        }),
      ],
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
      runCleanup: () => retention.run(),
      runRefresh: async (cycleId) => {
        const currentLeague = await repositories.leagues.findCurrent();
        if (!currentLeague) throw new Error('CURRENT_LEAGUE_UNRESOLVED');
        return new FullRefreshOrchestrator({
          league: refreshLeagueContext(currentLeague),
          marketJobs,
          marketDependencies,
          repositories,
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
