import { collectRecipeMaterialPrices } from './marketEconomy.js';
import {
  createMarketAdminStore,
  defaultAdminSettings,
  type AdminQueue,
} from './marketAdmin.js';
import { createMarketAdminStatusReader } from './marketAdminStatus.js';
import { marketAdminRefreshSchema } from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';
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
import {
  refreshFailureCode,
  watchRefreshCancellation,
} from './refreshCancellation.js';
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
  const repositories = createPostgresRepositories(pool);
  const economy = createMarketEconomyRepository(pool);
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
  const economyClient = new NinjaEconomyClient({
    userAgent: process.env.NINJA_USER_AGENT ?? config.poeUserAgent,
    readTimeoutMs: async () => (await admin.read()).effective.requestTimeoutMs,
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
    async () => (await admin.read()).effective.maximumQuoteAgeMs,
  );
  let jobs: ApplicationJobScheduler | undefined;
  let tradeClient: PoeTradeClient | undefined;
  const refreshProducer =
    modeIncludesApi(config.mode) && !modeIncludesWorker(config.mode)
      ? new ManualRefreshProducer(createJobBoss(pool, config.jobSchema, logger))
      : undefined;
  const research = createMarketResearchRepository(pool);
  const collectionStore = createMarketCollectionRepository(pool);
  const collectionManager = new MarketCollectionManager({
    adapter: configuredCollectionSource(
      new GggRateLimitController({ repository: repositories.rateLimits }),
      process.env,
      economy,
      async () => (await admin.read()).effective.requestTimeoutMs,
    ),
    store: collectionStore,
    readControls: async () => (await admin.read()).effective,
  });
  function producer() {
    const result = jobs ?? refreshProducer;
    if (!result) throw new DomainError('PERSISTENCE_UNAVAILABLE');
    return result;
  }
  const adminQueue: AdminQueue = {
    enqueue: (data, id, db) => producer().enqueue(data, id, db),
    cancel: (id) => producer().cancel(id),
  };
  const api = modeIncludesApi(config.mode)
    ? buildApi(
        logger,
        async () => {
          await pool.query('select 1');
          if (
            modeIncludesWorker(config.mode) &&
            !(await admin.workerHealth()).healthy
          )
            throw new Error('WORKER_HEARTBEAT_MISSING');
        },
        repositories.catalog.getProgress,
        repositories.rateLimits.list,
        resourceReaders.readCatalog,
        resourceReaders.readRecipe,
        repositories.leagues.list,
        repositories.leagues.findCurrent,
        {
          marketAdmin: {
            store: admin,
            queue: adminQueue,
            status: createMarketAdminStatusReader({
              store: admin,
              repositories,
              collection: collectionManager,
              economy,
              ninja: economyClient,
              readCatalog: resourceReaders.readCatalog,
            }),
          },
          diagnosticsToken: config.operatorDiagnosticsToken,
          metrics: metrics.registry,
          marketResearch: research,
          marketCollection:
            collectionStore && collectionManager
              ? { manager: collectionManager, store: collectionStore }
              : undefined,
          marketEconomy: {
            repository: economy,
            client: economyClient,
            readRetention: async () => (await admin.read()).effective,
          },
          readCircuits: repositories.providerCircuits.list,
          readOperationalDiagnostics: repositories.operationalDiagnostics.read,
          readRefreshFreshness: createRefreshFreshnessReader({
            cron: config.refreshCron,
            findLatestAttempt: repositories.cycles.findLatestAttempt,
            getProgress: repositories.catalog.getProgress,
            timezone: config.refreshTimezone,
          }),
          triggerRefresh: async () =>
            (
              await admin.enqueue(
                { scope: 'all' },
                'legacy-refresh',
                adminQueue,
              )
            ).id,
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
    function createTradeClient(requestTimeoutMs: number) {
      return new PoeTradeClient({
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
        requestTimeoutMs,
        userAgent: config.poeUserAgent,
      });
    }
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
      boss: createJobBoss(pool, config.jobSchema, logger),
      cleanupCron: config.cleanupCron,
      logger,
      refreshCron: config.refreshCron,
      refreshTimezone: config.refreshTimezone,
      control: {
        readSchedule: async () => {
          const settings = (await admin.read()).effective;
          return {
            enabled:
              settings.automaticRefreshEnabled &&
              settings.scheduledCollectionEnabled &&
              !settings.collectionsPaused,
            cron: settings.refreshCron,
            timezone: config.refreshTimezone,
          };
        },
        heartbeat: async () => {
          const current = (await admin.read()).version;
          await admin.reconcile({
            state: (id) => producer().state(id),
            cancel: adminQueue.cancel,
          });
          await admin.heartbeat(current);
        },
      },
      runCleanup: async () => {
        const settings = (await admin.read()).effective;
        await admin.cleanupObservations(settings);
        await economy.cleanup?.({
          payloadBefore: new Date(
            Date.now() - settings.rawRetentionHours * 3_600_000,
          ),
          snapshotsBefore: new Date(
            Date.now() - settings.historyRetentionDays * 86_400_000,
          ),
        });
        return new RetentionCleaner({
          batchSize: config.retentionBatchSize,
          repositories,
          rawSnapshotsRetentionMs: settings.rawRetentionHours * 3_600_000,
          observationsRetentionMs: settings.historyRetentionDays * 86_400_000,
        }).run();
      },
      runRefresh: async (cycleId, rawData, jobSignal) => {
        const scope = marketAdminRefreshSchema.parse(
          rawData?.scope === 'recipe'
            ? { scope: 'recipe', recipeId: rawData.recipeId }
            : { scope: rawData?.scope ?? 'all' },
        );
        const data = { ...scope, source: rawData?.source ?? 'scheduler' };
        if (!(await admin.claim(cycleId, data))) return { skipped: true };
        const cancellation = watchRefreshCancellation(
          () => admin.cancellationRequested(cycleId),
          () =>
            logger.warn(
              { cycleId },
              'refresh cancellation check failed; will retry',
            ),
        );
        const signal = jobSignal
          ? AbortSignal.any([jobSignal, cancellation.signal])
          : cancellation.signal;
        const abort = () => tradeClient?.stop();
        signal.addEventListener('abort', abort, { once: true });
        try {
          const settings = (await admin.read()).effective;
          const currentLeague = await repositories.leagues.findCurrent();
          if (!currentLeague)
            throw new DomainError('CURRENT_LEAGUE_UNRESOLVED');
          const collectMaterialPrices = () =>
            collectRecipeMaterialPrices(
              currentLeague.gggId,
              economyClient,
              economy,
              signal,
              (report) => admin.progress(cycleId, report),
            );
          if (scope.scope === 'economy') {
            const report = await collectMaterialPrices();
            signal.throwIfAborted();
            await admin.finish(
              cycleId,
              report.failed ? 'failed' : 'succeeded',
              report.errorCode,
            );
            return report;
          }
          tradeClient = createTradeClient(settings.requestTimeoutMs);
          const marketJobs = new MarketJobProcessor({
            concurrency: settings.collectionConcurrency,
            leaseTimeoutMs: config.jobLeaseTimeoutMs,
            logger,
            metrics,
            providers: [tradeClient],
            repositories,
            retryDelayMs: config.marketRetryDelayMs,
            snapshotTtlMs: Math.min(
              settings.snapshotReuseTtlMs,
              settings.maximumQuoteAgeMs,
            ),
          });
          const report = await new FullRefreshOrchestrator({
            collectMaterialPrices: async () => {
              await collectMaterialPrices();
            },
            league: refreshLeagueContext(currentLeague),
            marketJobs,
            marketDependencies,
            economy,
            repositories,
            logger,
            metrics,
            snapshotTtlMs: Math.min(
              settings.snapshotReuseTtlMs,
              settings.maximumQuoteAgeMs,
            ),
            maximumQuoteAgeMs: settings.maximumQuoteAgeMs,
            signal,
            ...(scope.scope === 'recipe' ? { recipeId: scope.recipeId } : {}),
            workerId: `worker-${process.pid}`,
          }).run(cycleId);
          await admin.finish(
            cycleId,
            report.publication.published ? 'succeeded' : 'failed',
            report.publication.published ? null : 'REFRESH_PUBLICATION_FAILED',
          );
          return report;
        } catch (error) {
          const code = refreshFailureCode(
            error,
            cancellation.signal,
            jobSignal,
          );
          const cancelled = code === 'MARKET_COLLECTION_CANCELLED';
          await admin.failCycle(cycleId, code);
          await admin.finish(cycleId, cancelled ? 'cancelled' : 'failed', code);
          throw error;
        } finally {
          cancellation.stop();
          signal.removeEventListener('abort', abort);
          tradeClient?.stop();
        }
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
    if (modeIncludesWorker(config.mode)) await collectionManager.start(5000);
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
