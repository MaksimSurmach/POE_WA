import { execFileSync } from 'node:child_process';
import { createDatabasePool } from '../apps/server/dist/database.js';
import { loadDatabaseConfig } from '../apps/server/dist/config.js';
import { resetIntegrationDatabase } from '../apps/server/dist/testkit/index.js';
import { runProcess } from '../apps/server/dist/process.js';

const target = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://invalid');
if (
  process.env.APP_ENV !== 'test' ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.pathname !== '/poe_worksmith_test' ||
  target.port === '54326'
)
  throw new Error(
    'Browser tests require the isolated local poe_worksmith_test database; native data is never reset.',
  );

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
    'all-success',
  ],
  { stdio: 'inherit' },
);
await runProcess('api');
