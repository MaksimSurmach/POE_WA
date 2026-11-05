import { defineConfig } from 'drizzle-kit';

import { drizzleConnectionString, loadDatabaseConfig } from './src/config.js';

const hasDatabaseEnvironment =
  process.env.APP_ENV ||
  process.env.DATABASE_URL ||
  process.env.TEST_DATABASE_URL;
const configuredDatabase = hasDatabaseEnvironment
  ? loadDatabaseConfig()
  : undefined;

export default defineConfig({
  dbCredentials: {
    url:
      (configuredDatabase
        ? drizzleConnectionString(configuredDatabase)
        : undefined) ??
      'postgresql://postgres:postgres@127.0.0.1:54322/poe_worksmith_dev',
  },
  dialect: 'postgresql',
  out: './drizzle',
  schema: './src/schema.ts',
  strict: true,
  verbose: true,
});
