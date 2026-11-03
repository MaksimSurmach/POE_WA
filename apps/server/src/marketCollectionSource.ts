import type { MarketCollectionSource } from '@poe-worksmith/contracts';
import {
  configuredMarketCollectionSource,
  createBatchedMarketCollectionSource,
} from './marketCollection.js';
import type { RateLimitGate } from './rateLimitController.js';
import type { MarketEconomyRepository } from './marketEconomy.js';
import {
  TradeCompatibleTransport,
  loadTradeCompatibleConfig,
} from './providers/tradeCompatible.js';

/** Selecting a provider is separate from enabling a profile's collection schedule. */
export function configuredCollectionSource(
  rateLimits: RateLimitGate,
  environment: Record<string, string | undefined> = process.env,
  economy?: Pick<MarketEconomyRepository, 'find'> &
    Partial<Pick<MarketEconomyRepository, 'latest'>>,
) {
  if (environment.MARKET_COLLECTION_SOURCE !== 'trade-compatible')
    return configuredMarketCollectionSource(
      environment.MARKET_COLLECTION_SOURCE,
    );
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
    };
  const transport = new TradeCompatibleTransport(
    loadTradeCompatibleConfig(environment),
    economy ? { economy } : {},
  );
  const source = createBatchedMarketCollectionSource({
    descriptor,
    rateLimits,
    transport,
  });
  return {
    get descriptor(): MarketCollectionSource {
      return { ...descriptor, connectionStatus: transport.connectionStatus };
    },
    collect: source.collect,
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
      const run = await manager.collectNow(stored.id, signal);
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
      };
    },
  };
}
