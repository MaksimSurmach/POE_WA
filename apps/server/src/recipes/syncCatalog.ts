import path from 'node:path';

import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { createPostgresRepositories } from '../repositories/index.js';
import { synchronizeRecipeCatalog } from './synchronizeRecipes.js';

const catalogPath = path.resolve(process.argv[2] ?? 'recipes');
const pool = createDatabasePool(loadDatabaseConfig());

try {
  const report = await synchronizeRecipeCatalog(
    catalogPath,
    createPostgresRepositories(pool).recipes,
  );
  process.stdout.write(`${JSON.stringify({ catalogPath, ...report })}\n`);
  if (report.failed.length > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Recipe synchronization failed'}\n`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
