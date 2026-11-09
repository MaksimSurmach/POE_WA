import { execFileSync } from 'node:child_process';
import { createDatabasePool } from '../apps/server/dist/database.js';
import { loadDatabaseConfig } from '../apps/server/dist/config.js';
import {
  assertLocalBrowserFixtureDatabase,
  resetIntegrationDatabase,
} from '../apps/server/dist/testkit/index.js';
import { runProcess } from '../apps/server/dist/process.js';

assertLocalBrowserFixtureDatabase();

const pool = createDatabasePool(loadDatabaseConfig());
try {
  await resetIntegrationDatabase(pool);
} finally {
  await pool.end();
}
execFileSync(
  process.execPath,
  [
    'apps/server/dist/entrypoints/integrationFixtures.js',
    '--scenario',
    process.env.BROWSER_FIXTURE_SCENARIO ?? 'all-success',
  ],
  { stdio: 'inherit' },
);
await runProcess('api');
