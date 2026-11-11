import { afterAll, beforeEach, expect, it } from 'vitest';

import {
  marketReadinessSchema,
  type RecipeEvaluation,
} from '@poe-worksmith/contracts';
import {
  createCollectorReadinessReader,
  targetReadiness,
} from './collectorReadiness.js';
import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import { createMarketActivityReader } from './marketActivity.js';
import { createCaptureRepository } from './repositories/captureRepository.js';
import { assertLocalBrowserFixtureDatabase } from './testkit/integrationScenarios.js';

assertLocalBrowserFixtureDatabase();
const pool = createDatabasePool(loadDatabaseConfig());
const captureRepository = createCaptureRepository(pool);
const hour = 3_600_000;
const now = new Date('2026-11-10T18:00:00Z');
const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * hour);

beforeEach(async () => {
  await pool.query(
    'truncate poe_leagues, collector_state, collector_schedule restart identity cascade',
  );
});
afterAll(async () => pool.end());

async function createSchedule(key: string, current = true) {
  const {
    rows: [league],
  } = await pool.query<{ id: string }>(
    `insert into poe_leagues(ggg_id,name,is_current,synced_at) values($1,$1,$2,$3) returning id`,
    [`League ${key}`, current, now],
  );
  const {
    rows: [schedule],
  } = await pool.query<{ id: string }>(
    `insert into collector_schedule(kind,key,league_id,payload,interval_minutes,next_due_at)
     values('trade-target',$1,$2,'{"recipeIds":[]}',60,$3) returning id`,
    [key, league!.id, now],
  );
  return schedule!.id;
}

const listings = [
  { itemId: 'a1', seller: 'a', amount: '11' },
  { itemId: 'a2', seller: 'a', amount: '12' },
  { itemId: 'a3', seller: 'a', amount: '10' },
  { itemId: 'b1', seller: 'b', amount: '11' },
  { itemId: 'b2', seller: 'b', amount: '10' },
];

async function capture(
  scheduleId: string,
  hoursAgo: number,
  complete: boolean,
  observed = listings,
) {
  await captureRepository.saveCapture({
    scheduleId,
    capturedAt: at(hoursAgo),
    reportedTotal: observed.length + (complete ? 0 : 1),
    fetched: observed.length,
    complete,
    partialReason: complete ? null : 'sample',
    slices: 1,
    durationMs: 10,
    listings: observed.map(({ itemId, seller, amount }) => ({
      itemId,
      seller,
      fingerprint: null,
      price: { amount, currency: 'chaos' },
      priceChaos: amount,
      indexedAt: null,
      item: {},
    })),
  });
}

it('reports each active query and upgrades one observed ask through timed evidence', async () => {
  const id = await createSchedule('query-v1');
  const previousLeague = await createSchedule('old-query', false);
  await capture(previousLeague, 12, true);
  await capture(id, 5, true, [listings[0]!]);
  const read = async (now: Date, evaluation?: RecipeEvaluation) =>
    marketReadinessSchema.parse(
      targetReadiness(
        (await createCollectorReadinessReader(pool)(now))[0]!,
        now,
        hour * 2,
        evaluation,
      ),
    );
  expect(await read(at(5))).toMatchObject({
    level: 'price-observed',
    currentSellers: 1,
    costVerified: false,
    last24h: { complete: 1, failed: null, inferredExits: null },
  });
  await capture(id, 4.5, false);
  expect(await read(at(4.5))).toMatchObject({
    level: 'price-observed',
    coverage: 'partial',
    last24h: { complete: 1, partial: 1, inferredExits: null },
  });
  await capture(id, 4, true);
  const survivors = [listings[2]!, listings[4]!];
  await capture(id, 3, true, survivors);
  expect(await read(at(3))).toMatchObject({
    level: 'price-observed',
    activityMeasurable: false,
    last24h: { complete: 3 },
  });
  await capture(id, 2, true, survivors);
  await capture(id, 1, true, survivors);
  expect(await read(at(1))).toMatchObject({
    level: 'activity-measurable',
    last24h: { complete: 5, inferredExits: 3, exitSellers: 2 },
  });
  await capture(id, 0, true, survivors);
  await expect(capture(id, 0, true, survivors)).rejects.toThrow(
    'persistence constraint',
  );
  const evaluation: RecipeEvaluation = {
    recipeId: 'test-recipe',
    status: 'success',
    source: {
      captureId: (await createCollectorReadinessReader(pool)(now))[0]!.schedule
        .captureId!,
      capturedAt: now.toISOString(),
      comparableSellers: 2,
      coverage: 'complete',
    },
    evaluatedAt: now.toISOString(),
    lastSuccessfulAt: now.toISOString(),
    errorCode: null,
    expectedCraftCost: { currency: 'chaos', amount: 8 },
    estimatedSalePrice: { currency: 'chaos', amount: 10 },
    profit: { currency: 'chaos', amount: 2 },
    marginPercent: 25,
    snapshotId: null,
  };
  expect(await read(now, evaluation)).toMatchObject({
    level: 'preliminary-candidate',
    last24h: {
      complete: 6,
      partial: 1,
      completeSpanMinutes: 300,
      inferredExits: 3,
      exitSellers: 2,
      sellers: 2,
      listings: 5,
      askRange: { min: { amount: 10 }, max: { amount: 12 } },
    },
  });
  expect(
    await read(now, { ...evaluation, expectedCraftCost: null }),
  ).toMatchObject({
    level: 'activity-measurable',
    costVerified: false,
  });
  expect(
    await read(now, {
      ...evaluation,
      source: {
        ...evaluation.source!,
        comparableSellers: 1,
        comparable: false,
      },
    }),
  ).toMatchObject({
    level: 'activity-measurable',
    currentSellers: 2,
    comparableSellers: 1,
    comparableAsks: false,
  });
  expect(await read(at(-3), evaluation)).toMatchObject({
    level: 'activity-measurable',
    fresh: false,
  });
  await pool.query(
    'insert into collector_state (id, telemetry_started_at) values (1, $1)',
    [at(1)],
  );
  await pool.query(
    `insert into collector_telemetry_runs (schedule_id, kind, started_at, finished_at, outcome)
     values ($1, 'trade-target', $2, $2, 'failed'), ($1, 'trade-target', $2, $2, 'other'),
            ($3, 'trade-target', $2, $2, 'failed')`,
    [id, at(0.5), previousLeague],
  );
  expect(await read(now)).toMatchObject({
    last24h: { failed: 1, failuresTrackedSince: at(1).toISOString() },
  });
  await pool.query(
    'update captures set query_version = null, floor_chaos = null where schedule_id = $1',
    [id],
  );
  expect(await read(now, evaluation)).toMatchObject({
    level: 'price-observed',
    activityMeasurable: false,
    last24h: { complete: 6, inferredExits: null, askRange: null },
  });
  expect(await createCollectorReadinessReader(pool)(now)).toHaveLength(1);
});

it('infers a single-listing exit only once the seller lists on another target of the league', async () => {
  const id = await createSchedule('solo-target');
  const {
    rows: [other],
  } = await pool.query<{ id: string; leagueId: string }>(
    `insert into collector_schedule(kind,key,league_id,payload,interval_minutes,next_due_at)
     select kind,'other-target',league_id,payload,60,next_due_at from collector_schedule
     where id = $1 returning id, league_id as "leagueId"`,
    [id],
  );
  const rest = [listings[3]!];
  await capture(id, 4, true, [
    { itemId: 's1', seller: 's', amount: '10' },
    ...rest,
  ]);
  await capture(id, 3, true, rest);
  await capture(id, 1, true, rest);
  const exits = async () => {
    const evidence = await createCollectorReadinessReader(pool)(now);
    const { last24h } = targetReadiness(
      evidence.find(({ schedule }) => schedule.id === id)!,
      now,
    );
    const view = await createMarketActivityReader(pool)(
      other!.leagueId,
      'solo-target',
      now,
    );
    return {
      readiness: [last24h.inferredExits ?? 0, last24h.uncertainExits],
      reader: [view?.inferredExits24h, view?.uncertainExits24h],
    };
  };
  // The same item on another target proves nothing about the seller.
  await capture(other!.id, 0.5, true, [
    { itemId: 's1', seller: 's', amount: '10' },
  ]);
  expect(await exits()).toEqual({ readiness: [0, 1], reader: [0, 1] });
  await capture(other!.id, 0.25, true, [
    { itemId: 's2', seller: 's', amount: '50' },
  ]);
  expect(await exits()).toEqual({ readiness: [1, 0], reader: [1, 0] });
});

it('keeps missing interval counts within the report window and abstains without a baseline', async () => {
  const id = await createSchedule('query-missing-intervals');
  const read = async () =>
    targetReadiness((await createCollectorReadinessReader(pool)(now))[0]!, now);
  expect((await read()).last24h.overdueIntervals).toBeNull();
  await capture(id, 48, true);
  expect((await read()).last24h).toMatchObject({
    complete: 0,
    overdueIntervals: 24,
  });
});
