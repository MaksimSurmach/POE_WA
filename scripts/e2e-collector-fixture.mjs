import assert from 'node:assert/strict';
import { loadDatabaseConfig } from '/app/dist/config.js';
import { createDatabasePool } from '/app/dist/database.js';
import {
  prepareCollectorBrowserFixture,
  resetIntegrationDatabase,
} from '/app/dist/testkit/index.js';

const target = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://invalid');
assert(
  process.env.APP_ENV === 'test' &&
    process.env.MARKET_COLLECTION_SOURCE === 'disabled' &&
    process.env.POE_TRADE_ACCESS === 'disabled' &&
    target.hostname === 'postgres' &&
    target.pathname === '/poe_worksmith_e2e' &&
    !target.search,
  'Collector fixture requires the offline packaged test database',
);
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
const pool = createDatabasePool(loadDatabaseConfig());
try {
  await resetIntegrationDatabase(pool);
  const start = await prepareCollectorBrowserFixture(pool, {
    recipeRoot: '/app/recipes',
    manualOnly: true,
    finishedSellerCount: 1,
  });
  await start(stop.signal);
} finally {
  await pool.end();
}
