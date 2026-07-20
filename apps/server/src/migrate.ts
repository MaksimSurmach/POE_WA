import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';

const pool = createDatabasePool(loadDatabaseConfig());

try {
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
  });
} finally {
  await pool.end();
}
