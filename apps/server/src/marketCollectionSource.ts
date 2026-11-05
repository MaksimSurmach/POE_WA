import type { MarketCollectionSource } from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';
import {
  configuredMarketCollectionSource,
  createBatchedMarketCollectionSource,
} from './marketCollection.js';
import type { RateLimitGate } from './rateLimitController.js';
import type { MarketEconomyRepository } from './marketEconomy.js';
import { marketCollectionRunner } from './config.js';
import {
  TradeCompatibleTransport,
  loadTradeCompatibleConfig,
} from './providers/tradeCompatible.js';
import {
  loadTradeLoginConfig,
  PoeTradeSessionManager,
} from './providers/poeTradeSessionManager.js';

type ConfiguredCollectionSource =
  import('./marketCollection.js').MarketCollectionAdapter & {
    start(): Promise<void>;
    close(): Promise<void>;
  };

/** Selecting a provider is separate from enabling a profile's collection schedule. */
export function configuredCollectionSource(
  rateLimits: RateLimitGate,
  environment: Record<string, string | undefined> = process.env,
  economy?: Pick<MarketEconomyRepository, 'find'> &
    Partial<Pick<MarketEconomyRepository, 'latest'>>,
  readTimeoutMs?: () => Promise<number>,
): ConfiguredCollectionSource {
  if (marketCollectionRunner(environment) === 'go')
    return {
      ...configuredMarketCollectionSource('disabled'),
      async start() {},
      async close() {},
    };
  if (environment.MARKET_COLLECTION_SOURCE !== 'trade-compatible')
    return {
      ...configuredMarketCollectionSource(environment.MARKET_COLLECTION_SOURCE),
      async start() {},
      async close() {},
    };
  const permitted = environment.POE_TRADE_ACCESS === 'owner_permitted';
  const descriptor: MarketCollectionSource = {
    id: 'trade-compatible',
    name: 'Trade-compatible website source',
    access: permitted ? 'authorized' : 'blocked',
    implementation: 'trade_compatible',
    authorization: permitted ? 'user_supplied' : 'unverified',
    dataKind: 'observed',
    connectionStatus: 'UNAVAILABLE',
    reason: permitted
      ? 'Owner-configured website access; this is not a documented GGG developer API authorization.'
      : 'Set POE_TRADE_ACCESS=owner_permitted only for access you are permitted to use. Automatic collection is disabled.',
  };
  if (!permitted)
    return {
      descriptor,
      async collect(): Promise<never> {
        throw new Error('Trade access is not configured');
      },
      async start() {},
      async close() {},
    };
  const tradeConfig = loadTradeCompatibleConfig(environment);
  const loginConfig = loadTradeLoginConfig(environment);
  const sessionManager = loginConfig
    ? new PoeTradeSessionManager(tradeConfig.baseURL, loginConfig, {
        onLogin: async () => {
          await rateLimits.clearAuthenticationDenials?.();
        },
      })
    : undefined;
  const transport = new TradeCompatibleTransport(tradeConfig, {
    ...(sessionManager ? { sessionManager } : {}),
    ...(economy ? { economy } : {}),
    ...(readTimeoutMs ? { readTimeoutMs } : {}),
  });
  const source = createBatchedMarketCollectionSource({
    descriptor,
    rateLimits,
    transport,
  });
  return {
    recoverableAuth: true,
    get descriptor(): MarketCollectionSource {
      return { ...descriptor, connectionStatus: transport.connectionStatus };
    },
    collect: source.collect,
    start: async () => {
      if (sessionManager)
        transport.connectionStatus = await sessionManager.start();
    },
    close: async () => sessionManager?.stop(),
  };
}

/** Adapt the existing durable collection owner to queued recipe refreshes. */
export function managedCollectionSource(
  manager: import('./marketCollection.js').MarketCollectionManager,
  research: Pick<
    import('./marketResearch.js').MarketResearchRepository,
    'saveTarget'
  >,
): import('./marketCollection.js').MarketCollectionAdapter {
  return {
    get descriptor() {
      return manager.source;
    },
    async collect({ target, signal }) {
      const stored = await research.saveTarget(target);
      let run: Awaited<ReturnType<typeof manager.collectNow>> | null = null;
      if (marketCollectionRunner() === 'go') {
        const requestId = await manager.enqueueRequest(
          stored.id,
          'recipe-refresh',
          true,
        );
        let completed = false;
        while (!signal.aborted) {
          const request = await manager.findRequest(requestId);
          if (request?.status === 'cancelled')
            throw new DomainError('MARKET_COLLECTION_CANCELLED');
          if (request?.runId) {
            const result = await manager.findRun(request.runId);
            if (result && result.status !== 'running') {
              if (
                result.dataKind !== 'observed' ||
                result.coverage !== 'complete' ||
                !result.snapshotId ||
                !['succeeded', 'empty'].includes(result.status)
              )
                throw new DomainError('MARKET_COLLECTION_FAILED');
              run = result;
              completed = true;
              break;
            }
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
        if (!completed) {
          await manager.cancelQueuedRequest(requestId);
          throw new DomainError('MARKET_COLLECTION_CANCELLED');
        }
      } else {
        run = await manager.collectNow(stored.id, signal);
      }
      if (!run) throw new DomainError('MARKET_COLLECTION_FAILED');
      return {
        batchCount: run.batchCount,
        cancelled: run.status === 'cancelled',
        cached: run.cached,
        ...(run.inexact === undefined ? {} : { inexact: run.inexact }),
        capturedAt: run.capturedAt,
        coverage: run.coverage ?? 'unknown',
        currency: run.currency,
        fetchedCount: run.fetchedCount,
        listings: run.listings,
        reportedTotal: run.reportedTotal,
        returnedCount: run.returnedCount,
        errorCode: run.errorCode,
        retryAt: run.retryAt,
        searchEvidence: run.searchEvidence,
        ...(run.sortedSampleComplete === undefined
          ? {}
          : {
              sortedSampleComplete:
                run.sortedSampleComplete &&
                !run.cancelRequested &&
                !run.errorCode &&
                run.status === 'partial',
            }),
      };
    },
  };
}
