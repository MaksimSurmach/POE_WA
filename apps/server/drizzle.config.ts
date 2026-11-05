import { defineConfig } from 'drizzle-kit';

import { loadDatabaseConfig } from './src/config.js';

const stagingDatabaseConfig =
  process.env.APP_ENV === 'staging' ? loadDatabaseConfig() : undefined;
const stagingDatabaseUrl = stagingDatabaseConfig
  ? new URL(stagingDatabaseConfig.connectionString)
  : undefined;

if (stagingDatabaseUrl) {
  stagingDatabaseUrl.searchParams.set('sslmode', 'verify-full');
}

export default defineConfig({
  dbCredentials: {
    url:
      stagingDatabaseUrl?.toString() ??
      process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@127.0.0.1:54322/poe_worksmith_dev',
  },
  dialect: 'postgresql',
  out: './drizzle',
  schema: './src/schema.ts',
  strict: true,
  verbose: true,
});
