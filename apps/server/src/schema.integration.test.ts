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
        'captures',
        'catalog_state',
        'canonical_entities',
        'collector_schedule',
        'collector_state',
        'collector_telemetry_runs',
        'game_data_versions',
        'jobs',
        'listing_events',
        'listings',
        'market_queries',
        'poe_leagues',
        'provider_circuits',
        'raw_snapshots',
        'rate_limit_endpoint_policies',
        'rate_limit_states',
        'recipe_evaluations',
        'recipe_results',
        'recipes',
        'refresh_cycles',
        'run_requests',
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
        'collector_schedule_enabled_due_idx',
        'collector_schedule_kind_key_uq',
        'run_requests_active_scope_recipe_uq',
        'collector_telemetry_runs_started_idx',
        'captures_schedule_time_uq',
        'listings_schedule_status_idx',
        'listings_schedule_seller_fingerprint_idx',
        'listing_events_schedule_item_time_idx',
        'listing_events_schedule_type_time_idx',
      ]),
    );
  });

  it('deduplicates active run requests per scope and recipe', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into recipes
           (id, content_hash, title, category, craft_method, game_version, guide_markdown, definition)
         values
           ('schema-test-a', 'schema-test-a', 'A', 'jewel', 'chaos', '3.25', '', '{}'),
           ('schema-test-b', 'schema-test-b', 'B', 'jewel', 'chaos', '3.25', '', '{}')`,
      );
      const result = await client.query<{
        scope: string;
        recipe_id: string | null;
        state: string;
      }>(
        `insert into run_requests (scope, recipe_id, state)
         values
           ('all', null, 'queued'),
           ('all', null, 'queued'),
           ('all', null, 'running'),
           ('recipe', 'schema-test-a', 'queued'),
           ('recipe', 'schema-test-a', 'queued'),
           ('recipe', 'schema-test-a', 'done'),
           ('recipe', 'schema-test-b', 'queued')
         on conflict do nothing
         returning scope, recipe_id, state`,
      );
      expect(result.rows).toHaveLength(4);
      expect(result.rows).toEqual(
        expect.arrayContaining([
          { scope: 'all', recipe_id: null, state: 'queued' },
          { scope: 'recipe', recipe_id: 'schema-test-a', state: 'queued' },
          { scope: 'recipe', recipe_id: 'schema-test-a', state: 'done' },
          { scope: 'recipe', recipe_id: 'schema-test-b', state: 'queued' },
        ]),
      );
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
