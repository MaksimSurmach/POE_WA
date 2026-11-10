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
