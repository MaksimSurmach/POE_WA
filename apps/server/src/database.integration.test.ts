import { afterAll, describe, expect, it, vi } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import { createDatabasePool, verifyDatabaseConnection } from './database.js';

const config = loadDatabaseConfig();
const pool = createDatabasePool(config);

afterAll(async () => {
  await pool.end();
});

describe('PostgreSQL integration', () => {
  it('reconnects after an idle backend is terminated without logging connection secrets', async () => {
    const warn = vi.fn();
    const reconnecting = createDatabasePool(config, { warn });
    try {
      const original = await reconnecting.query<{ pid: number }>(
        'select pg_backend_pid() as pid',
      );
      const pid = original.rows[0]!.pid;
      await pool.query('select pg_terminate_backend($1)', [pid]);
      await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
      const recovered = await reconnecting.query<{ pid: number }>(
        'select pg_backend_pid() as pid',
      );
      expect(recovered.rows[0]?.pid).not.toBe(pid);
      expect(warn).toHaveBeenCalledWith(
        'Idle PostgreSQL connection lost; pool will reconnect',
      );
    } finally {
      await reconnecting.end();
    }
  });

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
