import { afterAll, describe, expect, it } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';

const config = loadDatabaseConfig();
const pool = createDatabasePool(config);

afterAll(async () => {
  await pool.end();
});

describe('migration baseline', () => {
  it('creates all core tables and key indexes', async () => {
    const tableResult = await pool.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = 'public'
       order by table_name`,
    );
    const indexResult = await pool.query<{ indexname: string }>(
      `select indexname
       from pg_indexes
       where schemaname = 'public'`,
    );

    expect(tableResult.rows.map(({ table_name }) => table_name)).toEqual(
      expect.arrayContaining([
        'aggregated_observations',
        'catalog_state',
        'jobs',
        'market_queries',
        'provider_circuits',
        'raw_snapshots',
        'rate_limit_endpoint_policies',
        'rate_limit_states',
        'recipe_evaluations',
        'recipes',
        'refresh_cycles',
      ]),
    );
    expect(indexResult.rows.map(({ indexname }) => indexname)).toEqual(
      expect.arrayContaining([
        'market_queries_canonical_hash_uq',
        'raw_snapshots_expires_at_idx',
        'refresh_cycles_single_running_uq',
        'jobs_pending_run_after_idx',
        'rate_limit_states_blocked_until_idx',
        'rate_limit_endpoint_policies_policy_idx',
        'provider_circuits_status_retry_at_idx',
      ]),
    );
  });
});
