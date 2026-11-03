import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { NewRecipeEvaluation, Recipe } from '@poe-worksmith/domain';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { createPostgresRepositories } from './postgresRepositories.js';
import {
  createPriceHistoryRepository,
  maximumPriceHistoryBuckets,
  priceObservationBackfillSql,
} from './priceHistoryRepository.js';

const config = loadDatabaseConfig();
const databaseUrl = new URL(config.connectionString);
if (
  config.environment !== 'test' ||
  databaseUrl.pathname !== '/poe_worksmith_test' ||
  !['localhost', '127.0.0.1', '[::1]', 'postgres-test'].includes(
    databaseUrl.hostname,
  )
) {
  throw new Error(
    'Price history integration tests require the isolated local poe_worksmith_test database',
  );
}
const pool = createDatabasePool(config);
const repositories = createPostgresRepositories(pool);
const history = createPriceHistoryRepository(pool);

const leagueId = '00000000-0000-4000-8000-0000000000a1';
const otherLeagueId = '00000000-0000-4000-8000-0000000000a2';
const hourMs = 3_600_000;
const dayMs = 24 * hourMs;

const recipe: Recipe = {
  active: true,
  category: 'jewel',
  contentHash: 'trend-hash-current',
  craftMethod: 'fossil',
  definition: {},
  gameVersion: '3.29',
  guideMarkdown: '# Craft',
  id: 'trend-recipe',
  tags: [],
  title: 'Trend Recipe',
};

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    `truncate table recipe_price_observations, recipe_price_daily, jobs,
       recipe_evaluations, raw_snapshots, aggregated_observations,
       catalog_state, market_queries, refresh_cycles, recipes, poe_leagues
       restart identity cascade`,
  );
  await pool.query(
    `insert into poe_leagues (id, ggg_id, name, is_current, synced_at)
     values ($1, 'Trend', 'Trend', true, now()), ($2, 'Old', 'Old', false, now())`,
    [leagueId, otherLeagueId],
  );
  await repositories.recipes.save(recipe);
});

async function cycle(league = leagueId) {
  const id = randomUUID();
  await pool.query(
    `insert into refresh_cycles (id, league_id, status) values ($1, $2, 'completed')`,
    [id, league],
  );
  return id;
}

function evaluation(
  overrides: Partial<NewRecipeEvaluation> & {
    capturedAt?: string;
    sellers?: number;
  } = {},
): Omit<NewRecipeEvaluation, 'refreshCycleId'> {
  const evaluatedAt = overrides.evaluatedAt ?? new Date();
  const capturedAt =
    overrides.capturedAt ??
    new Date(evaluatedAt.getTime() - 5 * 60_000).toISOString();
  const { sellers, ...rest } = overrides;
  delete rest.capturedAt;
  return {
    confidence: 'medium',
    currency: 'chaos',
    errorCode: null,
    estimatedSalePrice: '100',
    evaluatedAt,
    expectedCraftCost: '40',
    lastSuccessfulAt: evaluatedAt,
    leagueId,
    marginPercent: '150',
    observationId: null,
    profit: '60',
    recipeId: recipe.id,
    sourceSnapshotDedupeKey: `snapshot-${capturedAt}`,
    status: 'success',
    methodCost: {
      recipeContentHash: recipe.contentHash,
      expiresAt: new Date(evaluatedAt.getTime() + 20 * 60_000).toISOString(),
      expectedCost: { amount: '40', currency: 'chaos' },
      source: {
        capturedAt,
        sampleSize: sellers ?? 5,
        priceBasis: 'asking',
        coverage: 'complete',
        sortedPageComplete: true,
        sortedSampleComplete: false,
      },
    },
    ...rest,
  };
}

async function save(
  value: Omit<NewRecipeEvaluation, 'refreshCycleId'>,
  refreshCycleId?: string,
) {
  return repositories.evaluations.save({
    ...value,
    refreshCycleId: refreshCycleId ?? (await cycle(value.leagueId)),
  });
}

async function observations() {
  return (
    await pool.query<{
      recipe_id: string;
      recipe_content_hash: string;
      league_id: string;
      currency: string;
      observed_at: Date;
      ask: string;
      craft_cost: string | null;
      comparable_sellers: number | null;
    }>('select * from recipe_price_observations order by observed_at, id')
  ).rows;
}

async function insertRaw(rows: { at: Date; ask: string; cost?: string }[]) {
  for (const row of rows)
    await pool.query(
      `insert into recipe_price_observations
         (recipe_id, recipe_content_hash, league_id, currency,
          source_snapshot_dedupe_key, observed_at, ask, craft_cost, comparable_sellers)
       values ($1, $2, $3, 'chaos', $4, $5, $6, $7, 3)`,
      [
        recipe.id,
        recipe.contentHash,
        leagueId,
        `raw-${row.at.toISOString()}-${row.ask}`,
        row.at,
        row.ask,
        row.cost ?? null,
      ],
    );
}

async function daily() {
  return (
    await pool.query<{
      bucket_start: Date;
      first_observed_at: Date;
      last_observed_at: Date;
      open_ask: string;
      high_ask: string;
      low_ask: string;
      close_ask: string;
      observation_count: number;
      craft_cost: string | null;
      craft_cost_observed_at: Date | null;
    }>('select * from recipe_price_daily order by bucket_start')
  ).rows;
}

function utcDay(daysAgo: number) {
  const now = Date.now();
  return new Date(Math.floor((now - daysAgo * dayMs) / dayMs) * dayMs);
}

describe('price observation persistence', () => {
  it('records one observation per source snapshot across concurrent, repeated and carried saves', async () => {
    const value = evaluation({ sourceSnapshotDedupeKey: 'snap-a' });
    const [cycleA, cycleB, cycleC] = await Promise.all([
      cycle(),
      cycle(),
      cycle(),
    ]);
    await Promise.all([save(value, cycleA), save(value, cycleB)]);
    await save(value, cycleA); // repeated save of the same cycle
    await save(
      { ...value, evaluatedAt: new Date(), status: 'partial' },
      cycleC,
    ); // carried into another cycle unchanged
    expect(await observations()).toHaveLength(1);

    await save(evaluation({ sourceSnapshotDedupeKey: 'snap-b' }));
    expect(await observations()).toHaveLength(2);
  });

  it('keeps the actual source capture time, not the evaluation time', async () => {
    const capturedAt = new Date(Date.now() - 3 * hourMs).toISOString();
    await save(evaluation({ capturedAt }));
    expect((await observations())[0]?.observed_at.toISOString()).toBe(
      capturedAt,
    );
  });

  it('separates recipe revisions, leagues and currencies', async () => {
    await save(evaluation({ sourceSnapshotDedupeKey: 'same' }));
    await save({
      ...evaluation({ sourceSnapshotDedupeKey: 'same' }),
      methodCost: {
        ...evaluation().methodCost,
        recipeContentHash: 'trend-hash-old',
      },
    });
    await save(
      evaluation({ sourceSnapshotDedupeKey: 'same', leagueId: otherLeagueId }),
    );
    await save(
      evaluation({
        sourceSnapshotDedupeKey: 'same',
        currency: 'divine',
        estimatedSalePrice: '0.5',
        expectedCraftCost: null,
      }),
    );
    const rows = await observations();
    expect(rows).toHaveLength(4);
    expect(
      new Set(
        rows.map(
          (r) => `${r.recipe_content_hash}|${r.league_id}|${r.currency}`,
        ),
      ).size,
    ).toBe(4);

    const summaries = await history.readSummaries({
      leagueId,
      range: '7d',
      now: new Date(),
    });
    const summary = summaries.get(recipe.id);
    // Only the current revision and league; the latest currency is shown alone.
    expect(summary?.latest.currency).toBe('divine');
    expect(summary?.window?.observations).toBe(1);
    expect(summary?.excludedCurrencies).toEqual(['chaos']);
  });

  it.each([
    ['stale fallback', { status: 'stale' as const }],
    ['error', { status: 'error' as const }],
    ['missing ask', { estimatedSalePrice: null }],
    ['unsupported currency', { currency: 'exalted' }],
    ['missing source snapshot', { sourceSnapshotDedupeKey: null }],
    ['missing method cost', { methodCost: null }],
    [
      'source captured after evaluation',
      { capturedAt: new Date(Date.now() + hourMs).toISOString() },
    ],
    ['invalid source time', { capturedAt: 'not-a-date' }],
    ['impossible source date', { capturedAt: '2026-02-30T00:00:00.000Z' }],
    [
      'source older than the raw history window',
      { capturedAt: new Date(Date.now() - 31 * dayMs).toISOString() },
    ],
  ])('skips %s without failing the evaluation save', async (_label, value) => {
    const saved = await save(evaluation(value));
    expect(saved.id).toBeGreaterThan(0);
    expect(await observations()).toHaveLength(0);
  });

  it('persists thin samples with seller metadata and only contemporaneous costs', async () => {
    const now = Date.now();
    await save(evaluation({ sellers: 1, sourceSnapshotDedupeKey: 'thin' }));
    await save({
      ...evaluation({ sourceSnapshotDedupeKey: 'expired-inputs' }),
      methodCost: {
        ...evaluation().methodCost,
        expiresAt: new Date(now - 60_000).toISOString(),
      },
    });
    await save({
      ...evaluation({ sourceSnapshotDedupeKey: 'no-expiry' }),
      methodCost: { ...evaluation().methodCost, expiresAt: undefined },
    });
    const rows = await pool.query<{
      source_snapshot_dedupe_key: string;
      craft_cost: string | null;
      comparable_sellers: number | null;
    }>(
      'select source_snapshot_dedupe_key, craft_cost, comparable_sellers from recipe_price_observations order by source_snapshot_dedupe_key',
    );
    expect(rows.rows).toEqual([
      {
        source_snapshot_dedupe_key: 'expired-inputs',
        craft_cost: null,
        comparable_sellers: 5,
      },
      {
        source_snapshot_dedupe_key: 'no-expiry',
        craft_cost: null,
        comparable_sellers: 5,
      },
      {
        source_snapshot_dedupe_key: 'thin',
        craft_cost: '40.00000000',
        comparable_sellers: 1,
      },
    ]);
  });

  it('backfills usable saved evaluations once and matches migration 0024', async () => {
    const refreshCycleId = await cycle();
    const old = evaluation({
      capturedAt: new Date(Date.now() - 90 * dayMs).toISOString(),
      evaluatedAt: new Date(Date.now() - 90 * dayMs + 60_000),
    });
    // Simulate a pre-migration evaluation saved without the price-history hook.
    await pool.query(
      `insert into recipe_evaluations (recipe_id, league_id, refresh_cycle_id, source_snapshot_dedupe_key,
         status, currency, expected_craft_cost, estimated_sale_price, method_cost, evaluated_at)
       values ($1, $2, $3, 'legacy', 'success', 'chaos', '40', '100', $4, $5),
              ($1, $2, $6, 'legacy', 'stale', 'chaos', '40', '100', $4, $5)`,
      [
        recipe.id,
        leagueId,
        refreshCycleId,
        JSON.stringify(old.methodCost),
        old.evaluatedAt,
        await cycle(),
      ],
    );
    expect(await history.backfill()).toBe(1);
    expect(await history.backfill()).toBe(0);
    expect((await observations())[0]?.craft_cost).toBe('40.00000000');

    const migration = await readFile(
      new URL('../../drizzle/0024_market_price_history.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain(priceObservationBackfillSql);
  });
});

describe('price history compaction', () => {
  it('rolls up out-of-order observations into exact daily OHLC idempotently', async () => {
    const day = utcDay(40);
    const at = (hours: number) => new Date(day.getTime() + hours * hourMs);
    await insertRaw([
      { at: at(10), ask: '120', cost: '50' },
      { at: at(2), ask: '100' },
      { at: at(20), ask: '90' },
      { at: at(5), ask: '150', cost: '45' },
    ]);
    const first = await history.compact({ batchSize: 2 });
    expect(first.rolledUp).toBe(4);
    expect(first.drained).toBe(true);
    expect(await observations()).toHaveLength(0);

    // Late observations for the same day arrive after the first rollup.
    await insertRaw([
      { at: at(1), ask: '80' },
      { at: at(23), ask: '110' },
    ]);
    await Promise.all([
      history.compact({ batchSize: 1 }),
      history.compact({ batchSize: 1 }),
    ]);
    expect(await history.compact({ batchSize: 10 })).toMatchObject({
      rolledUp: 0,
    });

    const [row, ...rest] = await daily();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      bucket_start: day,
      first_observed_at: at(1),
      last_observed_at: at(23),
      open_ask: '80.00000000',
      high_ask: '150.00000000',
      low_ask: '80.00000000',
      close_ask: '110.00000000',
      observation_count: 6,
      craft_cost: '50.00000000',
      craft_cost_observed_at: at(10),
    });
  });

  it('never compacts recent observations and enforces daily retention', async () => {
    await insertRaw([{ at: new Date(Date.now() - 2 * dayMs), ask: '10' }]);
    await history.compact({
      batchSize: 10,
      before: new Date(Date.now() + dayMs),
    });
    expect(await observations()).toHaveLength(1);

    await insertRaw([
      { at: new Date(utcDay(800).getTime() + hourMs), ask: '7' },
      { at: new Date(utcDay(400).getTime() + hourMs), ask: '8' },
    ]);
    await history.compact({ batchSize: 10 });
    expect((await daily()).map((r) => r.close_ask)).toEqual(['8.00000000']);
    await history.compact({ batchSize: 10, dailyRetentionDays: 365 });
    expect(await daily()).toHaveLength(0);
  });

  it('handles empty data', async () => {
    expect(await history.compact({ batchSize: 5 })).toEqual({
      rolledUp: 0,
      dailyDeleted: 0,
      drained: true,
    });
  });
});

describe('price history reads', () => {
  it('returns observed buckets only, merging raw and daily rows without zero-fill', async () => {
    const now = new Date();
    const oldDay = utcDay(45);
    await insertRaw([
      { at: new Date(oldDay.getTime() + hourMs), ask: '100' },
      { at: new Date(oldDay.getTime() + 2 * hourMs), ask: '130' },
    ]);
    await history.compact({ batchSize: 10 });
    await insertRaw([
      { at: new Date(now.getTime() - 10 * dayMs), ask: '140' },
      { at: new Date(now.getTime() - 3 * hourMs), ask: '150', cost: '60' },
      { at: new Date(now.getTime() - 2 * hourMs), ask: '160' },
    ]);
    const year = await history.readBuckets({
      leagueId,
      recipeId: recipe.id,
      currency: 'chaos',
      range: '1y',
      now,
    });
    expect(year.length).toBeLessThanOrEqual(4);
    expect(year[0]).toMatchObject({
      start: oldDay,
      open: '100.00000000',
      close: '130.00000000',
      observations: 2,
    });
    expect(year.reduce((sum, b) => sum + b.observations, 0)).toBe(5);

    const day = await history.readBuckets({
      leagueId,
      recipeId: recipe.id,
      currency: 'chaos',
      range: '24h',
      now,
    });
    expect(day.map((b) => b.close)).toEqual(['150.00000000', '160.00000000']);
    expect(day[0]?.craftCost).toBe('60.00000000');
    expect(day[1]?.craftCost).toBeNull();

    const summary = (
      await history.readSummaries({ leagueId, range: '1y', now })
    ).get(recipe.id);
    expect(summary).toMatchObject({
      latest: { ask: '160.00000000', craftCost: '60.00000000' },
      window: { open: '100.00000000', close: '160.00000000', observations: 5 },
    });
  });

  it('bounds the number of returned buckets', async () => {
    const now = new Date();
    const rows = Array.from({ length: 400 }, (_, index) => ({
      at: new Date(now.getTime() - index * 0.9 * dayMs - 60_000),
      ask: String(100 + index),
    }));
    await insertRaw(rows);
    await history.compact({ batchSize: 1000 });
    const buckets = await history.readBuckets({
      leagueId,
      recipeId: recipe.id,
      currency: 'chaos',
      range: '1y',
      now,
    });
    expect(buckets.length).toBeLessThanOrEqual(maximumPriceHistoryBuckets);
    expect(buckets.length).toBeGreaterThan(300);
  });

  it('hides series for a recipe whose current revision has no history', async () => {
    await insertRaw([{ at: new Date(Date.now() - hourMs), ask: '10' }]);
    await repositories.recipes.save({
      ...recipe,
      contentHash: 'trend-hash-v2',
    });
    expect(
      (
        await history.readSummaries({
          leagueId,
          range: '24h',
          now: new Date(),
        })
      ).size,
    ).toBe(0);
  });
});
