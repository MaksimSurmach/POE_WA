import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeEach, expect, it } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import { recipeQueryTarget } from './recipeMarket.js';
import { loadRecipeCatalog } from './recipes/loader.js';
import {
  synchronizeCollectorSchedules,
  synchronizeRecipes,
} from './recipes/synchronizeRecipes.js';
import { createPostgresRepositories } from './repositories/index.js';
import { loadCollectorScheduleConfig } from './runtimeConfig.js';
import { collectorSchedule } from './schema.js';
import { importTradeMappings } from './tradeMappings.js';

const pool = createDatabasePool(loadDatabaseConfig());
const database = drizzle({ client: pool });
const repositories = createPostgresRepositories(pool);
const catalog = fileURLToPath(new URL('../../../recipes', import.meta.url));
const cli = fileURLToPath(
  new URL('../dist/recipes/syncCatalog.js', import.meta.url),
);
const exec = promisify(execFile);
const cadence = {
  CLEANUP_CRON: '25 3 * * *',
  LEAGUE_RESOLVE_CRON: '17 9 * * *',
  LEAGUE_RESOLVE_TIMEZONE: 'America/New_York',
};

function syncCli(args: string[] = [], env: Record<string, string> = {}) {
  return exec(process.execPath, [cli, catalog, ...args], {
    env: { ...process.env, ...cadence, ...env },
  });
}

async function seedPrerequisites() {
  const league = await repositories.leagues.upsert({
    endAt: null,
    game: 'poe1',
    gggId: 'FixtureGGG',
    isCurrent: true,
    metadata: {},
    name: 'Fixture display name',
    realm: 'pc',
    startAt: null,
    syncedAt: new Date(),
  });
  const patch = '3.29.3.3';
  await pool.query(
    `insert into game_data_versions (game, patch_version, source, source_revision, manifest_hash, status)
     values ('poe1', $1, 'fixture', 'fixture', 'collector-schedule', 'active')`,
    [patch],
  );
  for (const name of ['physical-large-cluster', 'recipe-catalog']) {
    const manifest = JSON.parse(
      await readFile(
        new URL(`../mappings/poe-trade/${patch}/${name}.json`, import.meta.url),
        'utf8',
      ),
    );
    await importTradeMappings(pool, {
      ...manifest,
      sourceRevision: manifest.mappingVersion,
    });
  }
  return league;
}

const scheduleRows = () =>
  database
    .select()
    .from(collectorSchedule)
    .orderBy(collectorSchedule.kind, collectorSchedule.key);

beforeEach(async () => {
  await pool.query(
    'truncate table collector_schedule, recipes, poe_leagues, game_data_versions restart identity cascade',
  );
});

afterAll(() => pool.end());

it('reconciles the 26-recipe catalog without resetting existing schedule rows', async () => {
  const league = await seedPrerequisites();
  await syncCli();
  const first = await scheduleRows();
  expect(first).toHaveLength(46);
  const tradeDue = first
    .filter(({ kind }) => kind === 'trade-target')
    .map(({ nextDueAt }) => nextDueAt.getTime())
    .sort((a, b) => a - b);
  expect(tradeDue).toHaveLength(43);
  expect(tradeDue.map((due) => due - tradeDue[0]!)).toEqual(
    Array.from({ length: 43 }, (_, index) => index * 60_000),
  );
  expect(first.find(({ kind }) => kind === 'economy')).toMatchObject({
    leagueId: league.id,
    intervalMinutes: 30,
    payload: { league: league.gggId },
  });
  for (const [kind, cron, timezone, time] of [
    [
      'league',
      cadence.LEAGUE_RESOLVE_CRON,
      cadence.LEAGUE_RESOLVE_TIMEZONE,
      '09:17',
    ],
    ['retention', cadence.CLEANUP_CRON, 'UTC', '03:25'],
  ] as const) {
    const row = first.find((row) => row.kind === kind)!;
    expect(row).toMatchObject({ payload: { cron, timezone } });
    expect(
      new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: timezone,
      }).format(row.nextDueAt),
    ).toBe(time);
  }

  await pool.query(
    `update collector_schedule set next_due_at = '2026-11-01 01:00Z',
     retry_at = '2026-11-01 02:00Z', leased_until = '2026-11-01 03:00Z',
     attempt = 2, last_status = 'failed', last_error = 'fixture'
     where kind = 'trade-target'`,
  );
  const withRuntimeState = await scheduleRows();
  await syncCli();
  expect(await scheduleRows()).toEqual(withRuntimeState);

  const chaos = 'physical-large-cluster-chaos';
  const jagged = 'physical-large-cluster-jagged';
  const shared = withRuntimeState.find(
    ({ intervalMinutes, payload }) =>
      intervalMinutes === 60 &&
      Array.isArray(payload.recipeIds) &&
      payload.recipeIds.includes(chaos),
  )!;
  expect(shared).toMatchObject({
    leagueId: league.id,
    payload: {
      recipeIds: [chaos, jagged],
    },
  });
  expect(
    recipeQueryTarget(
      (shared.payload.query as { handbookTarget: unknown }).handbookTarget,
    ).league,
  ).toBe(league.gggId);
  const unique = withRuntimeState.find(
    ({ intervalMinutes, payload }) =>
      intervalMinutes === 120 &&
      Array.isArray(payload.recipeIds) &&
      payload.recipeIds.includes(chaos),
  )!;
  expect(unique.payload.recipeIds).toEqual([chaos]);
  const recipes = await loadRecipeCatalog(catalog);
  const report = await synchronizeRecipes(
    repositories.recipes,
    recipes.filter(({ definition }) => definition.id !== chaos),
    (path) => readFile(resolve(catalog, path)),
  );
  expect(report.disabled).toEqual([chaos]);
  await synchronizeCollectorSchedules(
    pool,
    loadCollectorScheduleConfig(cadence),
  );
  expect(await scheduleRows()).toEqual(
    withRuntimeState.map((row) => {
      if (row.id === unique.id) return { ...row, enabled: false };
      if (row.id === shared.id)
        return { ...row, payload: { ...row.payload, recipeIds: [jagged] } };
      return row;
    }),
  );
});

it('keeps recipe sync and dry-run safe without league or mapping data', async () => {
  await syncCli();
  expect(await repositories.recipes.listActive()).toHaveLength(26);
  expect(await scheduleRows()).toEqual([]);

  await seedPrerequisites();
  await syncCli(['--dry-run']);
  expect(await scheduleRows()).toEqual([]);
  await syncCli();
  const existing = await scheduleRows();
  expect(existing).toHaveLength(46);
  await pool.query("update game_data_versions set status = 'archived'");
  await syncCli();
  expect(await scheduleRows()).toEqual(existing);
});

it('validates only schedule configuration before writing recipes', async () => {
  await seedPrerequisites();
  await expect(syncCli([], { CLEANUP_CRON: 'invalid' })).rejects.toThrow();
  expect(await repositories.recipes.listActive()).toHaveLength(0);

  await syncCli([], { APP_PORT: 'invalid' });
  expect(await repositories.recipes.listActive()).toHaveLength(26);
  expect(await scheduleRows()).toHaveLength(46);
});

it('disables only retention during shadow collection and can re-enable it', async () => {
  await seedPrerequisites();
  await syncCli();
  const previous = await scheduleRows();
  await syncCli([], { COLLECTOR_RETENTION_ENABLED: 'false' });
  expect(await scheduleRows()).toEqual(
    previous.map((row) =>
      row.kind === 'retention' ? { ...row, enabled: false } : row,
    ),
  );
  await syncCli();
  expect(await scheduleRows()).toEqual(previous);
});

it('moves the due time when cron changes and keeps active leases intact', async () => {
  await seedPrerequisites();
  await syncCli();
  await pool.query(
    `update collector_schedule set next_due_at = '2026-11-02 13:00Z',
     retry_at = '2026-11-02 14:00Z', attempt = 2,
     leased_until = case when kind = 'retention' then '2026-11-02 15:00Z'::timestamptz end
     where kind in ('league', 'retention')`,
  );
  const previous = await scheduleRows();
  await synchronizeCollectorSchedules(
    pool,
    {
      cleanupCron: '0 15 * * *',
      collectorRetentionEnabled: true,
      leagueResolveCron: cadence.LEAGUE_RESOLVE_CRON,
      leagueResolveTimezone: 'UTC',
    },
    new Date('2026-11-02T12:00:00Z'),
  );
  expect(await scheduleRows()).toEqual(
    previous.map((row) => {
      if (row.kind === 'league')
        return {
          ...row,
          nextDueAt: new Date('2026-11-03T09:17:00Z'),
          payload: { ...row.payload, timezone: 'UTC' },
        };
      if (row.kind === 'retention')
        return { ...row, payload: { ...row.payload, cron: '0 15 * * *' } };
      return row;
    }),
  );
});

it('skips a reconciliation if its source changed before the write lock', async () => {
  await seedPrerequisites();
  await syncCli();
  const previous = await scheduleRows();
  const lock = await pool.connect();
  const lockKey = 'poe-worksmith:collector-schedule-sync';
  await lock.query('select pg_advisory_lock(hashtext($1))', [lockKey]);
  const pending = synchronizeCollectorSchedules(
    pool,
    loadCollectorScheduleConfig(cadence),
  );
  try {
    await expect
      .poll(async () => {
        const result = await pool.query(
          `select 1 from pg_locks where locktype = 'advisory' and not granted
           and database = (select oid from pg_database where datname = current_database())`,
        );
        return result.rowCount;
      })
      .toBe(1);
    await pool.query(
      "update recipes set content_hash = 'changed' where id = 'physical-large-cluster-chaos'",
    );
  } finally {
    await lock.query('select pg_advisory_unlock(hashtext($1))', [lockKey]);
    lock.release();
  }
  await expect(pending).resolves.toBe('stale-input');
  expect(await scheduleRows()).toEqual(previous);
});
