import { execFileSync } from 'node:child_process';
import { createDatabasePool } from '../apps/server/dist/database.js';
import { loadDatabaseConfig } from '../apps/server/dist/config.js';
import {
  assertLocalBrowserFixtureDatabase,
  prepareCollectorBrowserFixture,
  resetIntegrationDatabase,
} from '../apps/server/dist/testkit/index.js';
import { runProcess } from '../apps/server/dist/process.js';

assertLocalBrowserFixtureDatabase();
process.env.PIPELINE ??= 'legacy';

const pool = createDatabasePool(loadDatabaseConfig());
const stop = new AbortController();
let collector;
try {
  await resetIntegrationDatabase(pool);
  if (process.env.PIPELINE === 'collector') {
    const start = await prepareCollectorBrowserFixture(pool);
    process.once('SIGTERM', () => stop.abort());
    process.once('SIGINT', () => stop.abort());
    collector = start(stop.signal).finally(() => pool.end());
  }
} finally {
  if (!collector) await pool.end();
}
if (!collector)
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
if (collector) await collector;
