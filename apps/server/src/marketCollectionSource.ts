import type { MarketCollectionSource } from '@poe-worksmith/contracts';
import {
  configuredMarketCollectionSource,
  createBatchedMarketCollectionSource,
} from './marketCollection.js';
import type { RateLimitGate } from './rateLimitController.js';
import {
  TradeCompatibleTransport,
  loadTradeCompatibleConfig,
} from './providers/tradeCompatible.js';

/** Selecting a provider is separate from enabling a profile's collection schedule. */
export function configuredCollectionSource(
  rateLimits: RateLimitGate,
  environment: Record<string, string | undefined> = process.env,
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
