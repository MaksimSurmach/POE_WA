import { readFile } from 'node:fs/promises';
import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { importMarketCatalog } from '../marketCatalog.js';
import { createMarketResearchRepository } from '../repositories/marketResearchRepository.js';

const file = process.argv[2];
if (!file)
  throw new Error('Usage: market:import-catalog <catalog.json> [--dry-run]');
const pool = createDatabasePool(loadDatabaseConfig());
try {
  const result = await importMarketCatalog(
    JSON.parse(await readFile(file, 'utf8')),
    createMarketResearchRepository(pool),
    process.argv.includes('--dry-run'),
  );
  console.log(
    JSON.stringify(
      {
        dryRun: result.dryRun,
        created: result.created,
        unchanged: result.unchanged,
        targets: result.targets.map(({ id, name }) => ({ id, name })),
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
