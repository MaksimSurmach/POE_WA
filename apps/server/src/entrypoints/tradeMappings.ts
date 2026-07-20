import { createDatabasePool } from '../database.js';
import { loadDatabaseConfig } from '../config.js';
import {
  importTradeMappings,
  loadAndValidateTradeMappingManifest,
} from '../tradeMappings.js';

const file = process.argv[2];
if (!file) throw new Error('Usage: trade-mappings <manifest-path>');
const pool = createDatabasePool(loadDatabaseConfig());
try {
  await importTradeMappings(
    pool,
    await loadAndValidateTradeMappingManifest(file),
  );
} finally {
  await pool.end();
}
