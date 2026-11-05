import { defineConfig } from 'drizzle-kit';

import { getDrizzleConnectionString } from './src/config.js';

export default defineConfig({
  dbCredentials: {
    url:
      getDrizzleConnectionString() ??
      'postgresql://postgres:postgres@127.0.0.1:54322/poe_worksmith_dev',
  },
  dialect: 'postgresql',
  out: './drizzle',
  schema: './src/schema.ts',
  strict: true,
  verbose: true,
});
