import pino from 'pino';

import { buildApi } from '../api.js';
import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { createMarketResearchRepository } from '../repositories/marketResearchRepository.js';
import { createMarketEconomyRepository } from '../repositories/marketEconomyRepository.js';
import { createMarketCollectionRepository } from '../repositories/marketCollectionRepository.js';
import { NinjaEconomyClient } from '../providers/ninjaEconomy.js';
import {
  configuredMarketCollectionSource,
  MarketCollectionManager,
} from '../marketCollection.js';

// An explicit API-only entrypoint. It never initializes the legacy Trade worker.
const logger = pino({
  name: 'poe-worksmith-market',
  level: process.env.LOG_LEVEL ?? 'info',
  redact: ['req.headers.authorization', 'req.headers.cookie'],
});
const environment = {
  ...process.env,
  APP_ENV: process.env.APP_ENV ?? 'development',
};
const hasDatabase =
  environment.APP_ENV === 'test'
    ? Boolean(process.env.TEST_DATABASE_URL)
    : Boolean(process.env.DATABASE_URL);
const pool = hasDatabase
  ? createDatabasePool(loadDatabaseConfig(environment))
  : undefined;
const collectionStore = pool
  ? createMarketCollectionRepository(pool)
  : undefined;
const collectionManager = collectionStore
  ? new MarketCollectionManager({
      adapter: configuredMarketCollectionSource(
        process.env.MARKET_COLLECTION_SOURCE,
      ),
      store: collectionStore,
    })
  : undefined;
function retentionDays(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 36_500)
    throw new Error(`${name} must be an integer between 1 and 36500`);
  return value;
}
const api = buildApi(
  logger,
  async () => {
    if (!pool)
      throw new Error(
        'Configure a local PostgreSQL database to enable persistence',
      );
    await pool.query('select 1');
  },
  async () => ({ active: null, published: null }),
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  {
    marketResearch: pool ? createMarketResearchRepository(pool) : undefined,
    marketCollection:
      collectionStore && collectionManager
        ? { manager: collectionManager, store: collectionStore }
        : undefined,
    marketEconomy: {
      repository: pool ? createMarketEconomyRepository(pool) : undefined,
      rawRetentionDays: retentionDays('MARKET_ECONOMY_RAW_RETENTION_DAYS', 90),
      summaryRetentionDays: retentionDays(
        'MARKET_ECONOMY_SUMMARY_RETENTION_DAYS',
        730,
      ),
      client: process.env.NINJA_USER_AGENT
        ? new NinjaEconomyClient({ userAgent: process.env.NINJA_USER_AGENT })
        : undefined,
    },
  },
);
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer from 1 to 65535');
await api.listen({ host: process.env.HOST ?? '127.0.0.1', port });
try {
  await collectionManager?.start();
} catch (error) {
  await collectionManager?.stop();
  await api.close();
  await pool?.end();
  throw error;
}
if (!pool)
  logger.info(
    'Market workbench started without persistence; connect PostgreSQL and apply migrations to enable imports',
  );

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await api.close();
  await collectionManager?.stop();
  await pool?.end();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
