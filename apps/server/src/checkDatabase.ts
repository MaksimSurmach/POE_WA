import { loadDatabaseConfig } from './config.js';
import { createDatabasePool, verifyDatabaseConnection } from './database.js';

try {
  const config = loadDatabaseConfig();
  const pool = createDatabasePool(config);

  try {
    const connection = await verifyDatabaseConnection(
      pool,
      config.connectionString,
    );
    console.log(
      `Database connection ready: ${connection.database} (PostgreSQL ${connection.serverVersion})`,
    );
  } finally {
    await pool.end();
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Unknown database startup error',
  );
  process.exitCode = 1;
}
