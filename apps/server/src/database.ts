import { Pool } from 'pg';

import type { DatabaseConfig } from './config.js';

export type DatabaseConnection = {
  database: string;
  serverVersion: string;
};

export class DatabaseConnectionError extends Error {
  constructor(target: string, cause: unknown) {
    super(
      `Database connection failed for ${target}. Check the selected environment URL, credentials, network access, and TLS mode.`,
      { cause },
    );
    this.name = 'DatabaseConnectionError';
  }
}

export function createDatabasePool(config: DatabaseConfig) {
  return new Pool({
    application_name: `poe-worksmith-${config.environment}`,
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
    max: config.maxConnections,
    ssl: config.ssl,
  });
}

export async function verifyDatabaseConnection(
  pool: Pool,
  connectionString: string,
): Promise<DatabaseConnection> {
  try {
    const result = await pool.query<{
      database: string;
      server_version: string;
    }>(
      "select current_database() as database, current_setting('server_version') as server_version",
    );
    const connection = result.rows[0];

    if (!connection) {
      throw new Error('PostgreSQL returned no health-check row');
    }

    return {
      database: connection.database,
      serverVersion: connection.server_version,
    };
  } catch (error) {
    throw new DatabaseConnectionError(
      safeDatabaseTarget(connectionString),
      error,
    );
  }
}

function safeDatabaseTarget(connectionString: string) {
  const url = new URL(connectionString);
  return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
}
