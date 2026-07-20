import { afterAll, describe, expect, it } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import { createDatabasePool, verifyDatabaseConnection } from './database.js';

const config = loadDatabaseConfig();
const pool = createDatabasePool(config);

afterAll(async () => {
  await pool.end();
});

describe('PostgreSQL integration', () => {
  it('connects only to the isolated test database', async () => {
    const connection = await verifyDatabaseConnection(
      pool,
      config.connectionString,
    );

    expect(config.environment).toBe('test');
    expect(connection.database).toBe('poe_worksmith_test');
    expect(connection.serverVersion).toMatch(/^17\./);
  });
});
