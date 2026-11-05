import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { createMarketResearchRepository } from '../repositories/marketResearchRepository.js';
import { createMarketCollectionRepository } from '../repositories/marketCollectionRepository.js';
import { createPostgresRepositories } from '../repositories/index.js';
import { GggRateLimitController } from '../rateLimitController.js';
import {
  TradeCompatibleTransport,
  loadTradeCompatibleConfig,
} from '../providers/tradeCompatible.js';
import {
  loadTradeLoginConfig,
  PoeTradeSessionManager,
} from '../providers/poeTradeSessionManager.js';

const targetId = process.argv[2];
if (!targetId)
  throw new Error('Usage: market:test-connection <saved-target-id>');
if (process.env.POE_TRADE_ACCESS !== 'owner_permitted')
  throw new Error(
    'Set POE_TRADE_ACCESS=owner_permitted for access you are permitted to use',
  );
const pool = createDatabasePool(loadDatabaseConfig());
let sessionManager: PoeTradeSessionManager | undefined;
try {
  const target =
    await createMarketResearchRepository(pool).findTarget(targetId);
  if (!target) throw new Error('Saved target not found');
  const tradeConfig = loadTradeCompatibleConfig();
  const loginConfig = loadTradeLoginConfig();
  const gate = new GggRateLimitController({
    repository: createPostgresRepositories(pool).rateLimits,
  });
  sessionManager = loginConfig
    ? new PoeTradeSessionManager(tradeConfig.baseURL, loginConfig, {
        onLogin: () => gate.clearAuthenticationDenials(),
      })
    : undefined;
  if (sessionManager) await sessionManager.start();
  if (
    await createMarketCollectionRepository(pool).isSourceBlocked(
      'trade-compatible',
      { ignoreAuthFailures: sessionManager?.sessionAvailable },
    )
  )
    throw new Error(
      'Source has a durable denial; resolve it before testing again',
    );
  const transport = new TradeCompatibleTransport(tradeConfig, {
    ...(sessionManager ? { sessionManager } : {}),
  });
  const signal = AbortSignal.timeout(90_000);
  let connected = false;
  try {
    await gate.waitForPermit('trade-search', signal);
    const search = await transport.search({ target, signal });
    await gate.observeResponse('trade-search', search);
    connected = search.status < 400 && search.data.ids.length === 0;
    if (search.status < 400 && search.data.ids[0]) {
      await gate.waitForPermit('trade-fetch', signal);
      const details = await transport.fetchDetails({
        target,
        ids: [search.data.ids[0]],
        queryId: search.data.queryId,
        signal,
      });
      await gate.observeResponse('trade-fetch', details);
      connected = details.status < 400;
    }
  } catch {
    /* Public state only: transport errors may carry private data. */
  }
  const status = connected
    ? 'CONNECTED'
    : transport.connectionStatus === 'CONNECTED'
      ? 'UNAVAILABLE'
      : transport.connectionStatus;
  console.log(
    JSON.stringify({
      status,
      targetId,
      sessionConfigured: Boolean(
        sessionManager || process.env.POE_TRADE_SESSION_ID,
      ),
      scope:
        'At most one search and one listing fetch; no snapshot or schedule is created.',
    }),
  );
  if (status !== 'CONNECTED') process.exitCode = 1;
} finally {
  await sessionManager?.stop();
  await pool.end();
}
