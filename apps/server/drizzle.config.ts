import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dbCredentials: {
    url:
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
