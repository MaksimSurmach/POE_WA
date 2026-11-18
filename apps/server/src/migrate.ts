import { fileURLToPath } from 'node:url';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';

const pool = createDatabasePool(loadDatabaseConfig());
const client = await pool.connect();
const config = {
  migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
};
try {
  await client.query("select pg_advisory_lock(hashtext('worksmith:migrate'))");
  // The homelab received the pool migration before master's two scraped-item migrations.
  // Drizzle skips earlier timestamps, so fill that specific gap before its normal migration pass.
  const migrations = readMigrationFiles(config);
  const poolMigration = migrations.find(
    (m) => m.folderMillis === 1795005693328,
  )!;
  const {
    rows: [journal],
  } = await client.query(
    "select to_regclass('drizzle.__drizzle_migrations') as present",
  );
  if (journal.present) {
    const { rows } = await client.query<{ hash: string }>(
      'select hash from drizzle.__drizzle_migrations',
    );
    const applied = new Set(rows.map((row) => row.hash));
    if (applied.has(poolMigration.hash)) {
      await client.query('begin');
      for (const m of migrations.filter(
        (m) =>
          [1794960514741, 1794964200933].includes(m.folderMillis) &&
          !applied.has(m.hash),
      )) {
        for (const statement of m.sql) await client.query(statement);
        await client.query(
          'insert into drizzle.__drizzle_migrations(hash, created_at) values ($1,$2)',
          [m.hash, m.folderMillis],
        );
      }
      await client.query('commit');
    }
  }
  await migrate(drizzle(client), config);
} finally {
  client.release(true);
  await pool.end();
}
