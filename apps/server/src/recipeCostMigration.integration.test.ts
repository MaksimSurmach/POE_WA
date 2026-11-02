import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabasePool } from './database.js';
import { loadDatabaseConfig } from './config.js';
const pool = createDatabasePool(loadDatabaseConfig());
afterAll(() => pool.end());
describe('single-method cost storage upgrade', () => {
  it('preserves historical evaluation payloads and linked raw evidence during an actual forward migration', async () => {
    const client = await pool.connect();
    const schema = `migration_${randomUUID().replaceAll('-', '')}`;
    try {
      await client.query('begin');
      await client.query(`create schema ${schema}`);
      await client.query(`set local search_path to ${schema}`);
      await client.query(
        'create table recipe_evaluations (like public.recipe_evaluations including defaults)',
      );
      await client.query(
        'alter table recipe_evaluations drop column method_cost',
      );
      await client.query(
        'create table raw_evidence (id text primary key,payload jsonb)',
      );
      await client.query(
        'insert into raw_evidence values (\'retained\', \'{"asking":100,"seller":"fixture"}\')',
      );
      await client.query(
        `insert into recipe_evaluations(recipe_id,refresh_cycle_id,league_id,status,evaluated_at,variant_costs,source_snapshot_dedupe_key) values ('historic','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','success',now(),'{"fossil":{"expectedCost":"123"}}','retained')`,
      );
      const before = await client.query(
        'select to_jsonb(e) as evaluation,(select jsonb_agg(r) from raw_evidence r) as evidence from recipe_evaluations e',
      );
      await client.query(
        await readFile(
          new URL('../drizzle/0022_single_method_cost.sql', import.meta.url),
          'utf8',
        ),
      );
      const after = await client.query(
        "select to_jsonb(e)-'method_cost' as evaluation,(select jsonb_agg(r) from raw_evidence r) as evidence,method_cost from recipe_evaluations e",
      );
      expect(after.rows[0]).toEqual({ ...before.rows[0], method_cost: null });
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
