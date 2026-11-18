import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeEach, expect, it } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import { readMarketDiscovery } from './marketDiscovery.js';
import { recipeQueryTarget } from './recipeMarket.js';
import { loadRecipeCatalog } from './recipes/loader.js';
import {
  synchronizeCollectorSchedules,
  synchronizeRecipes,
  synchronizeStoredRecipeCatalog,
} from './recipes/synchronizeRecipes.js';
import { createPostgresRepositories } from './repositories/index.js';
import { createCaptureRepository } from './repositories/captureRepository.js';
import { loadCollectorScheduleConfig } from './runtimeConfig.js';
import { collectorSchedule, collectorTradePools } from './schema.js';
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

async function seedPrerequisites(gggId = 'FixtureGGG') {
  const league = await repositories.leagues.upsert({
    endAt: null,
    game: 'poe1',
    gggId,
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

it('reconciles the 72-recipe catalog without resetting existing schedule rows', async () => {
  const league = await seedPrerequisites();
  await syncCli();
  const first = await scheduleRows();
  expect(first).toHaveLength(128);
  const recipes = await loadRecipeCatalog(catalog);
  const tradeRows = first.filter(({ kind }) => kind === 'trade-target');
  expect(tradeRows).toHaveLength(125);
  const pools = await database.select().from(collectorTradePools);
  expect(pools).toHaveLength(2);
  for (const [priority, period, count] of [
    [1, 180, 66],
    [2, 720, 59],
  ] as const) {
    const poolRows = tradeRows.filter(
      (row) => row.scrapingPriority === priority,
    );
    expect(poolRows).toHaveLength(count);
    const pool = pools.find((row) => row.priority === priority)!;
    expect(pool.periodMinutes).toBe(period);
    const step = (period * 60_000) / count;
    const sorted = poolRows.sort(
      (a, b) => a.nextDueAt.getTime() - b.nextDueAt.getTime(),
    );
    sorted.forEach((row, index) => {
      expect(row.intervalMinutes).toBe(period);
      expect((row.payload.outputRecipeIds as string[]).length > 0).toBe(
        priority === 1,
      );
      const elapsed = row.nextDueAt.getTime() - pool.startedAt.getTime();
      expect(elapsed).toBeGreaterThanOrEqual((index + 0.95) * step - 1);
      expect(elapsed).toBeLessThanOrEqual((index + 1) * step + 1);
    });
  }
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
  await syncCli();
  expect(await scheduleRows()).toEqual(withRuntimeState);

  const chaos = 'physical-large-cluster-chaos';
  const jagged = 'physical-large-cluster-jagged';
  const shared = withRuntimeState.find(
    ({ scrapingPriority, payload }) =>
      scrapingPriority === 1 &&
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
  const sharedBase = withRuntimeState.find(
    ({ scrapingPriority, payload }) =>
      scrapingPriority === 2 &&
      Array.isArray(payload.recipeIds) &&
      payload.recipeIds.includes(chaos),
  )!;
  expect(sharedBase.payload.recipeIds).toEqual([chaos, jagged]);
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
      if (row.id === sharedBase.id)
        return {
          ...row,
          payload: { ...row.payload, recipeIds: [jagged] },
        };
      if (row.id === shared.id)
        return {
          ...row,
          payload: {
            ...row.payload,
            recipeIds: [jagged],
            outputRecipeIds: [jagged],
          },
        };
      return row;
    }),
  );
}, 15_000);

it('shares the highest priority, rejects new unconfigured assignments and isolates legacy ones', async () => {
  await seedPrerequisites();
  const chaos = 'physical-large-cluster-chaos';
  const jagged = 'physical-large-cluster-jagged';
  const recipes = (await loadRecipeCatalog(catalog)).filter(({ definition }) =>
    [chaos, jagged].includes(definition.id),
  );
  const sync = async (jaggedOutput: number) => {
    await synchronizeRecipes(
      repositories.recipes,
      recipes.map((source) => ({
        ...source,
        definition: {
          ...source.definition,
          scrapingPriority:
            source.definition.id === chaos
              ? { base: 1, output: 2 }
              : { output: jaggedOutput },
        },
      })),
      (path) => readFile(resolve(catalog, path)),
    );
    return synchronizeCollectorSchedules(
      pool,
      loadCollectorScheduleConfig(cadence),
    );
  };

  await sync(1);
  const first = await scheduleRows();
  const shared = first.find(({ payload }) =>
    (payload.outputRecipeIds as string[] | undefined)?.includes(jagged),
  )!;
  expect(shared).toMatchObject({
    scrapingPriority: 1,
    payload: { outputRecipeIds: [chaos, jagged] },
  });
  const chaosBase = first.find(
    ({ payload }) =>
      (payload.outputRecipeIds as string[] | undefined)?.length === 0 &&
      (payload.recipeIds as string[]).includes(chaos),
  );
  expect(chaosBase).toMatchObject({ scrapingPriority: 1 });
  await sync(2);
  const second = await scheduleRows();
  expect(second.find(({ id }) => id === shared.id)).toMatchObject({
    scrapingPriority: 2,
    intervalMinutes: 720,
  });
  const unsupported = recipes.map((source) => ({
    ...source,
    definition: { ...source.definition, scrapingPriority: { base: 7 } },
  }));
  const before = await repositories.recipes.listAll();
  await expect(
    synchronizeRecipes(repositories.recipes, unsupported, (path) =>
      readFile(resolve(catalog, path)),
    ),
  ).rejects.toThrow(/period for Trade pool 7/);
  expect(await repositories.recipes.listAll()).toEqual(before);
  // Simulate a legacy recipe written ahead of the settings change.
  await pool.query(
    `update recipes set definition = jsonb_set(definition, '{scrapingPriority}', '{"base": 7}')`,
  );
  await expect(
    synchronizeCollectorSchedules(pool, loadCollectorScheduleConfig(cadence)),
  ).resolves.toBe('synchronized');
  const legacy = await scheduleRows();
  expect(legacy.find((row) => row.id === chaosBase!.id)?.scrapingPriority).toBe(
    7,
  );
  expect(legacy.find((row) => row.id === shared.id)?.intervalMinutes).toBe(180);
});

it('validates configured priorities before importing any catalog recipe', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'worksmith-priority-catalog-'));
  const { definition } = (await loadRecipeCatalog(catalog))[0]!;
  await writeFile(
    resolve(root, 'recipe.json'),
    JSON.stringify({ ...definition, scrapingPriority: { output: 7 } }),
  );
  const previous = await pool.query(
    'select * from market_admin_settings where id = 1',
  );
  try {
    await pool.query('delete from market_admin_settings where id = 1');
    for (const dryRun of [true, false]) {
      await expect(
        synchronizeStoredRecipeCatalog(root, pool, { dryRun }),
      ).rejects.toThrow(/period for Trade pool 7/);
      expect(await repositories.recipes.listAll()).toHaveLength(0);
    }
    await pool.query(
      `insert into market_admin_settings (id, settings) values (1, '{"tradePoolMinutes":{"1":180,"2":720,"7":1440}}')`,
    );
    expect(
      (await synchronizeStoredRecipeCatalog(root, pool, {})).created,
    ).toEqual([definition.id]);
  } finally {
    await pool.query('delete from market_admin_settings where id = 1');
    if (previous.rows[0]) {
      const { version, settings, updated_at } = previous.rows[0];
      await pool.query(
        'insert into market_admin_settings (id,version,settings,updated_at) values (1,$1,$2,$3)',
        [version, settings, updated_at],
      );
    }
    await rm(root, { recursive: true, force: true });
  }
});

it('rolls all recipe targets to a new league while retaining disabled old history', async () => {
  const previous = await seedPrerequisites('Standard');
  await syncCli();
  const before = await scheduleRows();
  const next = await repositories.leagues.upsert({
    endAt: null,
    game: 'poe1',
    gggId: 'Next Challenge',
    isCurrent: false,
    metadata: {},
    name: 'Next Challenge',
    realm: 'pc',
    startAt: null,
    syncedAt: new Date(),
  });
  await repositories.leagues.setCurrent(next.id, new Date());
  await syncCli();
  const after = await scheduleRows();
  const oldTargets = after.filter(
    (row) => row.kind === 'trade-target' && row.leagueId === previous.id,
  );
  const newTargets = after.filter(
    (row) => row.kind === 'trade-target' && row.leagueId === next.id,
  );
  expect(oldTargets).toHaveLength(125);
  expect(oldTargets.every((row) => !row.enabled)).toBe(true);
  expect(newTargets).toHaveLength(125);
  expect(newTargets.every((row) => row.enabled)).toBe(true);
  expect(
    after.find((row) => row.kind === 'economy' && row.enabled),
  ).toMatchObject({ leagueId: next.id, payload: { league: 'Next Challenge' } });
  expect(
    newTargets.every((row) => !before.some((old) => old.id === row.id)),
  ).toBe(true);
  await syncCli();
  expect(await scheduleRows()).toEqual(after);
});

it('keeps recipe sync and dry-run safe without league or mapping data', async () => {
  await syncCli();
  expect(await repositories.recipes.listActive()).toHaveLength(72);
  expect(await scheduleRows()).toEqual([]);

  await seedPrerequisites();
  await syncCli(['--dry-run']);
  expect(await scheduleRows()).toEqual([]);
  await syncCli();
  const existing = await scheduleRows();
  expect(existing).toHaveLength(128);
  await pool.query("update game_data_versions set status = 'archived'");
  await syncCli();
  expect(await scheduleRows()).toEqual(existing);
});

it('validates only schedule configuration before writing recipes', async () => {
  await seedPrerequisites();
  await expect(syncCli([], { CLEANUP_CRON: 'invalid' })).rejects.toThrow();
  expect(await repositories.recipes.listActive()).toHaveLength(0);

  await syncCli([], { APP_PORT: 'invalid' });
  expect(await repositories.recipes.listActive()).toHaveLength(72);
  expect(await scheduleRows()).toHaveLength(128);
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

it('ranks Allflame research queries only after three complete captures', async () => {
  await seedPrerequisites('Allflame');
  await syncCli();
  const rows = (await scheduleRows()).filter(
    ({ payload }) => payload.discovery === true,
  );
  expect(rows).toHaveLength(2);
  expect(
    rows.every(
      ({ enabled, intervalMinutes, scrapingPriority }) =>
        enabled && intervalMinutes === 360 && scrapingPriority === null,
    ),
  ).toBe(true);
  expect(new Set(rows.map(({ key }) => key)).size).toBe(2);
  expect(await readMarketDiscovery(pool)).toMatchObject({
    sales: 'unknown',
    entries: [
      { readiness: { level: 'insufficient', currentAskRange: null } },
      { readiness: { level: 'insufficient', currentAskRange: null } },
    ],
  });

  const target = rows[0]!;
  const now = new Date('2026-11-10T15:00:00Z');
  const captureRepository = createCaptureRepository(pool);
  for (const hoursAgo of [12, 6, 0]) {
    await captureRepository.saveCapture({
      scheduleId: target.id,
      capturedAt: new Date(now.getTime() - hoursAgo * 3_600_000),
      reportedTotal: 1,
      fetched: 1,
      complete: true,
      slices: 1,
      durationMs: 10,
      listings: [
        {
          itemId: 'discovery-listing',
          seller: 'seller',
          fingerprint: null,
          price: { amount: '15', currency: 'chaos' },
          priceChaos: '15',
          indexedAt: null,
          item: {},
        },
      ],
    });
    const report = await readMarketDiscovery(
      pool,
      new Date(now.getTime() - hoursAgo * 3_600_000),
    );
    const entry = report.entries.find(
      ({ name }) => name === target.payload.name,
    );
    expect(entry?.readiness).toMatchObject({
      level: hoursAgo === 0 ? 'activity-measurable' : 'price-observed',
      last24h: { complete: 3 - hoursAgo / 6 },
      currentAskRange: { min: { amount: 15, currency: 'chaos' } },
    });
  }
});
