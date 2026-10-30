import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  marketCollectionRunSchema,
  type MarketCollectionRun,
} from '@poe-worksmith/contracts';

import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { createMarketTarget } from '../marketResearch.js';
import { compareMarketObservations } from '../marketCollection.js';
import { createMarketResearchRepository } from './marketResearchRepository.js';
import { createMarketCollectionRepository } from './marketCollectionRepository.js';

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
    'Market collection integration tests require the isolated local poe_worksmith_test database',
  );
}
const pool = createDatabasePool(config);
const repository = createMarketCollectionRepository(pool);
const targets = createMarketResearchRepository(pool);

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    'truncate market_collection_runs, market_collection_settings, market_research_snapshots, belt_price_updates, market_targets',
  );
});

function makeTarget() {
  return createMarketTarget({
    name: 'Stygian profile',
    game: 'poe1',
    realm: 'pc',
    league: 'Test League',
    patch: '3.29',
    slot: 'Belt',
    baseTypes: ['Stygian Vise'],
    builds: [],
    requiredMods: [],
    sources: [],
  });
}

function makeRun(
  targetDigest: string,
  targetId: string,
  status: MarketCollectionRun['status'] = 'running',
): MarketCollectionRun {
  const at = new Date().toISOString();
  const id = randomUUID();
  return marketCollectionRunSchema.parse({
    id,
    targetId,
    targetDigest,
    league: 'Test League',
    patch: '3.29',
    sourceId: 'fixture-replay',
    queryDigest: 'a'.repeat(64),
    dataKind: 'demo',
    trigger: 'manual',
    status,
    coverage: status === 'running' ? null : 'complete',
    reportedTotal: null,
    returnedCount: 0,
    fetchedCount: 0,
    cached: false,
    currency: null,
    listings: [],
    startedAt: at,
    capturedAt: null,
    completedAt: status === 'running' ? null : at,
    batchCount: 0,
    listingCount: 0,
    errorCode: null,
    retryAt: null,
    snapshotId: status === 'running' ? null : id,
    cancelRequested: false,
  });
}

describe('persistent managed market collection', () => {
  it('retains per-listing currency for same-currency analytics after repository reload', async () => {
    const target = await targets.saveTarget(makeTarget());
    const base = makeRun(target.digest, target.id, 'partial');
    const run = marketCollectionRunSchema.parse({
      ...base,
      coverage: 'partial',
      currency: 'divine',
      returnedCount: 2,
      fetchedCount: 2,
      listingCount: 2,
      listings: [
        {
          externalId: 'chaos-listing',
          price: 100,
          currency: 'chaos',
          item: {},
          fingerprint: 'a'.repeat(64),
        },
        {
          externalId: 'divine-listing',
          price: 2,
          currency: 'divine',
          item: {},
          fingerprint: 'b'.repeat(64),
        },
      ],
    });
    await repository.saveRun(run);
    const observations = await createMarketCollectionRepository(pool).listObservations(target.id);
    expect(observations[0]?.listings.map(({ currency }) => currency)).toEqual([
      'chaos',
      'divine',
    ]);
    expect(compareMarketObservations(observations)[0]?.median).toBe(2);
  });

  it('keeps each run, survives repository recreation and recovers abandoned work', async () => {
    const target = await targets.saveTarget(makeTarget());
    const settings = {
      targetId: target.id,
      enabled: true,
      paused: false,
      intervalMinutes: 5,
      nextRunAt: '2026-10-30T10:05:00.000Z',
      updatedAt: '2026-10-30T10:00:00.000Z',
    };
    await repository.saveSettings(settings);
    const first = makeRun(target.digest, target.id, 'empty');
    const second = makeRun(target.digest, target.id, 'empty');
    const pending = makeRun(target.digest, target.id);
    await repository.saveRun(first);
    await repository.saveRun(second);
    await repository.saveRun(pending);
    await repository.requestCancel(pending.id);

    const reopened = createMarketCollectionRepository(pool);
    expect(await reopened.findSettings(target.id)).toEqual(settings);
    expect(
      (await reopened.listRuns(target.id)).map((run) => run.id),
    ).toHaveLength(3);
    expect(await reopened.findRun(first.id)).toEqual(first);

    const completionRacingCancellation = await reopened.saveRun({
      ...pending,
      status: 'succeeded',
      coverage: 'complete',
      returnedCount: 1,
      fetchedCount: 1,
      listingCount: 1,
      listings: [
        {
          externalId: 'cancelled-detail',
          price: 7,
          item: { name: 'preserved detail' },
          fingerprint: 'd'.repeat(64),
        },
      ],
      completedAt: '2026-10-30T10:05:00.000Z',
      snapshotId: pending.id,
    });
    expect(completionRacingCancellation).toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
      coverage: 'partial',
      listingCount: 1,
      snapshotId: pending.id,
    });

    const abandoned = makeRun(target.digest, target.id);
    await reopened.saveRun(abandoned);

    await reopened.recoverRunningRuns('2026-10-30T10:10:00.000Z');
    await expect(reopened.findRun(abandoned.id)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'MARKET_COLLECTION_INTERRUPTED',
      completedAt: '2026-10-30T10:10:00.000Z',
    });
    await expect(
      reopened.saveRun({
        ...abandoned,
        status: 'succeeded',
        coverage: 'complete',
        completedAt: '2026-10-30T10:11:00.000Z',
        snapshotId: abandoned.id,
      }),
    ).resolves.toMatchObject({ status: 'failed' });
  });

  it('does not claim a schedule after a concurrent pause', async () => {
    const target = await targets.saveTarget(makeTarget());
    const due = {
      targetId: target.id,
      enabled: true,
      paused: false,
      intervalMinutes: 5,
      nextRunAt: '2026-10-30T10:05:00.000Z',
      updatedAt: '2026-10-30T10:00:00.000Z',
    };
    await repository.saveSettings(due);
    await repository.saveSettings({ ...due, paused: true, nextRunAt: null });
    await expect(
      repository.claimScheduledSettings(
        { ...due, nextRunAt: '2026-10-30T10:10:00.000Z' },
        due.nextRunAt,
      ),
    ).resolves.toBe(false);
    await expect(repository.findSettings(target.id)).resolves.toMatchObject({
      paused: true,
      nextRunAt: null,
    });
  });

  it('does not recover a live request waiting through a long rate-limit cooldown', async () => {
    const target = await targets.saveTarget(makeTarget());
    const running = {
      ...makeRun(target.digest, target.id),
      startedAt: '2026-10-30T09:00:00.000Z',
    };
    await repository.saveRun(running);

    await repository.recoverRunningRuns('2026-10-30T10:00:00.000Z', [
      running.id,
    ]);
    await repository.recoverRunningRuns('2026-10-30T10:20:00.000Z', []);
    await expect(repository.findRun(running.id)).resolves.toMatchObject({
      status: 'running',
    });

    await repository.recoverRunningRuns('2026-10-30T10:31:00.000Z', []);
    await expect(repository.findRun(running.id)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'MARKET_COLLECTION_INTERRUPTED',
    });
  });

  it('returns durable cancellation requests to the manager holding the run', async () => {
    const target = await targets.saveTarget(makeTarget());
    const running = makeRun(target.digest, target.id);
    await repository.saveRun(running);
    await repository.requestCancel(running.id);

    await expect(
      repository.recoverRunningRuns('2026-10-30T10:00:00.000Z', [running.id]),
    ).resolves.toEqual([running.id]);
    await expect(repository.findRun(running.id)).resolves.toMatchObject({
      status: 'running',
      cancelRequested: true,
    });
  });

  it('projects analytics identity without loading raw listing items', async () => {
    const target = await targets.saveTarget(makeTarget());
    const run = marketCollectionRunSchema.parse({
      ...makeRun(target.digest, target.id, 'succeeded'),
      currency: 'chaos',
      returnedCount: 1,
      fetchedCount: 1,
      listingCount: 1,
      listings: [
        {
          externalId: 'fixture-listing',
          price: 7,
          item: { name: 'raw fixture data' },
          fingerprint: 'c'.repeat(64),
        },
      ],
    });
    await repository.saveRun(run);

    const observations = await repository.listObservations(target.id);
    expect(observations).toMatchObject([
      {
        id: run.id,
        listings: [
          {
            externalId: 'fixture-listing',
            price: 7,
            fingerprint: 'c'.repeat(64),
          },
        ],
      },
    ]);
    expect(observations[0]?.listings[0]).not.toHaveProperty('item');
  });
});
