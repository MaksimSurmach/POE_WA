import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { readMarketDiscovery } from '../marketDiscovery.js';

const pool = createDatabasePool(loadDatabaseConfig());
try {
  console.log(JSON.stringify(await readMarketDiscovery(pool), null, 2));
} finally {
  await pool.end();
}
