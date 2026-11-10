import { createIntelligenceService } from './intelligence.js';
import { createIntelligenceRepository } from './repositories/intelligenceRepository.js';
import { createFactoryService } from './factory.js';
import { createFactoryRepository } from './repositories/factoryRepository.js';
import { createCraftAnalysisService } from './craftAnalysis.js';
import { createCraftAnalysisRepository } from './repositories/craftAnalysisRepository.js';
import { collectRecipeMaterialPrices } from './marketEconomy.js';
import {
  createMarketAdminStore,
  defaultAdminSettings,
  scheduledRefreshEnabled,
  type AdminQueue,
} from './marketAdmin.js';
import { createMarketAdminStatusReader } from './marketAdminStatus.js';
import { marketAdminRefreshSchema } from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';
import {
  synchronizeCollectorSchedules,
  synchronizeRecipeCatalog,
} from './recipes/synchronizeRecipes.js';
import { runCollector } from './collector.js';
import { configuredTradeCapture } from './collectorTrade.js';
import { existsSync } from 'node:fs';
import pino from 'pino';
import type { PoolClient } from 'pg';
import { fileURLToPath } from 'node:url';

import { buildApi } from './api.js';
import { ProviderCircuitBreaker } from './circuitBreaker.js';
import { createDatabasePool } from './database.js';
import {
  ApplicationJobScheduler,
  createJobBoss,
  ManualRefreshProducer,
} from './jobs.js';
import { HttpPoeTradeLeagueClient, LeagueResolver } from './leagues.js';
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
import { createTradeSessionRepository } from './repositories/tradeSessionRepository.js';
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
import { ApplicationRuntime, runCollectorRuntime } from './runtime.js';
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
import { createPriceHistoryRepository } from './repositories/priceHistoryRepository.js';
import { marketCollectionRunner } from './config.js';
import { createMarketTrendsReader } from './marketTrendsApi.js';
import {
  NinjaEconomyClient,
  NinjaEconomyError,
} from './providers/ninjaEconomy.js';
import { MarketCollectionManager } from './marketCollection.js';
import {
  configuredCollectionSource,
  managedCollectionSource,
} from './marketCollectionSource.js';

export async function runProcess(forcedMode?: ApplicationMode) {
  const collectionRunner = marketCollectionRunner(process.env);
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
      const trade = configuredTradeCapture(rateLimits, economy, process.env);
      const sessionKey = process.env.POE_TRADE_SESSION_KEY;
      await runCollectorRuntime(
        (signal) =>
          runCollector({
            pool: leaderPool,
            signal,
            onError: (code) =>
              logger.warn({ code }, 'collector operation will retry'),
            bootstrap: async (client, jobSignal) => {
              const pinned = createPostgresRepositories(pool, client);
              const report = await synchronizeRecipeCatalog(
                catalogPath,
                pinned.recipes,
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
  const workerShutdown = new AbortController();
  const refreshProducer =
    modeIncludesApi(config.mode) && !modeIncludesWorker(config.mode)
      ? new ManualRefreshProducer(createJobBoss(pool, config.jobSchema, logger))
      : undefined;
  const research = createMarketResearchRepository(pool);
  const collectionStore = createMarketCollectionRepository(pool);
  const collectionSource = configuredCollectionSource(
    new GggRateLimitController({ repository: repositories.rateLimits }),
    process.env,
    economy,
    async () => (await admin.read()).effective.requestTimeoutMs,
  );
  const collectionManager = new MarketCollectionManager({
    adapter: collectionSource,
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
  const craftAnalysis = createCraftAnalysisService({
    repository: createCraftAnalysisRepository(pool),
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
          craftAnalysis,
          intelligence: createIntelligenceService({
            repository: createIntelligenceRepository(pool),
            economy,
            factory: createFactoryRepository(pool),
            analysis: craftAnalysis,
            recipes: repositories.recipes,
            leagues: repositories.leagues,
            marketDependencies,
            settings: async () => (await admin.read()).effective.intelligence,
            maximumQuoteAgeMs: async () =>
              (await admin.read()).effective.maximumQuoteAgeMs,
            onError: (error) =>
              logger.warn(
                { err: error },
                'Intelligence refresh unavailable; existing evidence preserved',
              ),
          }),
          factory: createFactoryService({
            repository: createFactoryRepository(pool),
            analysis: craftAnalysis,
            leagues: repositories.leagues,
          }),
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
              collectorStatus: async () => {
                if (collectionRunner !== 'go') return null;
                try {
                  const result = await pool.query<{
                    state: 'starting' | 'healthy' | 'draining' | 'unhealthy';
                    heartbeat_at: Date | null;
                    owner_epoch: string | null;
                    owns_lease: boolean;
                  }>(`select case when w.heartbeat_at > now()-interval '90 seconds'
                                       and o.lease_expires_at > now() then w.state else 'unhealthy' end as state,
                              w.heartbeat_at,o.owner_epoch::text,
                              (o.owner_instance_id=w.instance_id and o.lease_expires_at>now()) as owns_lease
                      from market_collection_workers w
                      left join market_collection_ownership o on o.owner_instance_id=w.instance_id
                      order by w.heartbeat_at desc limit 1`);
                  const row = result.rows[0];
                  const requests = await pool.query<{
                    queued: string;
                    claimed: string;
                  }>(`select count(*) filter (where state='queued')::text as queued,
                            count(*) filter (where state='claimed')::text as claimed
                       from market_collection_requests`);
                  return {
                    runner: collectionRunner,
                    enabled: row?.owns_lease ?? false,
                    state: row?.state ?? null,
                    heartbeatAt: row?.heartbeat_at?.toISOString() ?? null,
                    ownerEpoch:
                      row?.owner_epoch === null ||
                      row?.owner_epoch === undefined
                        ? null
                        : Number(row.owner_epoch),
                    queuedRequests: Number(requests.rows[0]?.queued ?? 0),
                    claimedRequests: Number(requests.rows[0]?.claimed ?? 0),
                  };
                } catch {
                  return null;
                }
              },
            }),
          },
          diagnosticsToken: config.operatorDiagnosticsToken,
          collectorPool: pool,
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
        allowRequests:
          collectionRunner !== 'go' &&
          process.env.POE_TRADE_ACCESS === 'owner_permitted',
        allowQueuedCollection: collectionRunner === 'go',
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
    const resolver = createLeagueResolver();
    jobs = new ApplicationJobScheduler({
      boss: createJobBoss(pool, config.jobSchema, logger),
      cleanupCron: config.cleanupCron,
      logger,
      refreshCron: config.refreshCron,
      refreshTimezone: config.refreshTimezone,
      control: {
        readSchedule,
        heartbeat: async () => {
          const current = (await admin.read()).version;
          await admin.reconcile({
            state: (id) => producer().state(id),
            cancel: adminQueue.cancel,
          });
          await admin.heartbeat(current);
        },
      },
      runCleanup,
      runRefresh: async (cycleId, rawData, jobSignal) => {
        const scope = marketAdminRefreshSchema.parse(
          rawData?.scope === 'recipe'
            ? { scope: 'recipe', recipeId: rawData.recipeId }
            : { scope: rawData?.scope ?? 'all' },
        );
        const data = { ...scope, source: rawData?.source ?? 'scheduler' };
        const workerSignal = jobSignal
          ? AbortSignal.any([jobSignal, workerShutdown.signal])
          : workerShutdown.signal;
        if (!(await admin.claim(cycleId, data, workerSignal)))
          return { skipped: true };
        const cancellation = watchRefreshCancellation(
          () => admin.cancellationRequested(cycleId),
          () =>
            logger.warn(
              { cycleId },
              'refresh cancellation check failed; will retry',
            ),
        );
        const signal = AbortSignal.any([workerSignal, cancellation.signal]);
        let runClient: PoeTradeClient | undefined;
        const abort = () => runClient?.stop();
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
          runClient = createTradeClient(settings.requestTimeoutMs);
          tradeClient = runClient;
          const marketJobs = new MarketJobProcessor({
            concurrency: settings.collectionConcurrency,
            leaseTimeoutMs: config.jobLeaseTimeoutMs,
            logger,
            metrics,
            providers: [runClient],
            repositories,
            retryDelayMs: config.marketRetryDelayMs,
            snapshotTtlMs: settings.maximumQuoteAgeMs,
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
            snapshotTtlMs: settings.snapshotReuseTtlMs,
            maximumQuoteAgeMs: settings.maximumQuoteAgeMs,
            freshnessWarningMs: settings.freshnessWarningMs,
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
            workerSignal,
          );
          const cancelled = code === 'MARKET_COLLECTION_CANCELLED';
          await admin.failCycle(cycleId, code);
          await admin.finish(cycleId, cancelled ? 'cancelled' : 'failed', code);
          throw error;
        } finally {
          cancellation.stop();
          signal.removeEventListener('abort', abort);
          runClient?.stop();
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
      workerShutdown.abort();
      tradeClient?.stop();
      await Promise.all([collectionManager?.stop(), collectionSource.close()]);
    },
    host: config.host,
    ...(jobs ? { jobs } : {}),
    logger,
    mode: config.mode,
    pool,
    port: config.port,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    shuttingDown = true;
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
    if (shuttingDown) return;
    await collectionSource.start();
    if (shuttingDown) return;
    if (modeIncludesWorker(config.mode) && collectionRunner !== 'go')
      await collectionManager.start(5000);
  } catch (error) {
    logger.fatal({ err: error }, 'application startup failed');
    await collectionManager?.stop().catch((cleanupError: unknown) => {
      logger.error({ err: cleanupError }, 'market collection cleanup failed');
    });
    await collectionSource.close().catch((cleanupError: unknown) => {
      logger.error({ err: cleanupError }, 'Trade session cleanup failed');
    });
    await runtime.stop().catch((cleanupError: unknown) => {
      logger.error({ err: cleanupError }, 'application startup cleanup failed');
    });
    process.exitCode = 1;
    return;
  }
}
