import path from 'node:path';

import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { createGameDataRepository } from '../gameData.js';
import { createPostgresRepositories } from '../repositories/index.js';
import { loadCollectorScheduleConfig } from '../runtimeConfig.js';
import {
  synchronizeCollectorSchedules,
  synchronizeRecipeCatalog,
} from './synchronizeRecipes.js';

const arguments_ = process.argv.slice(2);
const unknownOption = arguments_.find(
  (argument) => argument.startsWith('-') && argument !== '--dry-run',
);
if (unknownOption) throw new Error(`Unknown option: ${unknownOption}`);
const dryRun = arguments_.includes('--dry-run');
const catalogPath = path.resolve(
  arguments_.find((argument) => !argument.startsWith('-')) ?? 'recipes',
);
const pool = createDatabasePool(loadDatabaseConfig());

try {
  const schedule = dryRun ? undefined : loadCollectorScheduleConfig();
  const report = await synchronizeRecipeCatalog(
    catalogPath,
    createPostgresRepositories(pool).recipes,
    { dryRun, gameData: await createGameDataRepository(pool).openActive() },
  );
  if (schedule && report.failed.length === 0) {
    await synchronizeCollectorSchedules(pool, schedule);
  }
  process.stdout.write(
    `${JSON.stringify({ catalogPath, dryRun, ...report })}\n`,
  );
  if (report.failed.length > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Recipe synchronization failed'}\n`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
