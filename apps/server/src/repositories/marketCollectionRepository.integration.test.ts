import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import {
  marketCollectionRunSchema,
  type MarketCollectionRun,
} from '@poe-worksmith/contracts';

import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { createMarketTarget } from '../marketResearch.js';
import {
  compareMarketObservations,
  createReplayMarketCollectionSource,
  createBatchedMarketCollectionSource,
  MarketCollectionManager,
  type MarketCollectionBatch,
} from '../marketCollection.js';
import { beltDemoFixture } from '../beltDemoFixture.js';
import { analyzeBeltSnapshot } from '../beltComparability.js';
import { buildApi } from '../api.js';
import { GggRateLimitController } from '../rateLimitController.js';
import { createPostgresRepositories } from './index.js';
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
    snapshotId: null,
    cancelRequested: false,
  });
}

describe('persistent managed market collection', () => {
  it('publishes sequential demo collections through matcher and the existing ranking API, idempotently', async () => {
    const now = new Date();
    const fixture = beltDemoFixture(now);
    const target = await targets.saveTarget(
      createMarketTarget(fixture.target, now),
    );
    const input = fixture.observation(target.id);
    const batch: MarketCollectionBatch = {
      batchCount: 1,
      cached: false,
      capturedAt: new Date(now.getTime() - 120_000).toISOString(),
      coverage: 'complete',
      currency: 'chaos',
      fetchedCount: input.listings.length,
      listings: input.listings,
      reportedTotal: input.listings.length,
      returnedCount: input.listings.length,
      sourceUrl: 'https://example.com/fixture-replay',
    };
    const later = {
      ...batch,
      capturedAt: new Date(now.getTime() - 60_000).toISOString(),
      listings: batch.listings.map((listing) => ({
        ...listing,
        price: listing.price! + 10,
      })),
    };
    const manager = new MarketCollectionManager({
      adapter: createReplayMarketCollectionSource([batch, later, later]),
      clock: () => now,
      store: repository,
    });
    const api = buildApi(
      pino({ level: 'silent' }),
      async () => {},
      async () => ({ active: null, published: null }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        marketResearch: targets,
        marketCollection: { manager, store: repository },
      },
    );
    try {
      const collect = async () => {
        const started = await manager.runNow(target.id);
        await vi.waitFor(async () => {
          expect((await repository.findRun(started.id))?.status).toBe(
            'succeeded',
          );
        });
        return (await repository.findRun(started.id))!;
      };
      const first = await collect();
      const firstSnapshot = await targets.findSnapshot(first.snapshotId!);
      expect(firstSnapshot).toMatchObject({
        provenance: 'collection',
        dataKind: 'demo',
      });
      expect(firstSnapshot?.listings).toEqual(batch.listings);
      expect(
        analyzeBeltSnapshot(target, firstSnapshot!, now.getTime())
          .confirmedListings,
      ).toBe(5);
      const initialRanking = await api.inject(
        '/api/market/belt-opportunities?kind=demo',
      );
      expect(initialRanking.statusCode).toBe(200);
      expect(initialRanking.json().data[0]).toMatchObject({
        snapshotId: first.snapshotId,
        status: 'CALCULATED',
        economicConclusion: 'POSITIVE',
      });
      const second = await collect();
      expect(second.snapshotId).not.toBe(first.snapshotId);
      const updatedRanking = await api.inject(
        '/api/market/belt-opportunities?kind=demo',
      );
      expect(updatedRanking.json().data[0].snapshotId).toBe(second.snapshotId);
      expect(
        Number(updatedRanking.json().data[0].calculation.spread),
      ).toBeGreaterThan(
        Number(initialRanking.json().data[0].calculation.spread),
      );
      const duplicate = await collect();
      expect(duplicate.snapshotId).toBe(second.snapshotId);
      const repeated = await collect();
      expect(repeated).toMatchObject({ cached: true, snapshotId: null });
      expect(await targets.listSnapshots()).toHaveLength(2);
      await repository.saveRun({ ...second, listings: [] });
      expect(
        (await targets.findSnapshot(second.snapshotId!))?.listings,
      ).toEqual(later.listings);
    } finally {
      await manager.stop();
      await api.close();
    }
  });

  it('preserves null prices in projected analytics and the collection API', async () => {
    const target = await targets.saveTarget(makeTarget());
    await repository.saveRun(
      marketCollectionRunSchema.parse({
        ...makeRun(target.digest, target.id, 'partial'),
        currency: 'chaos',
        listings: [
          {
            externalId: 'unpriced',
            price: null,
            item: {},
            fingerprint: 'd'.repeat(64),
          },
        ],
        listingCount: 1,
        returnedCount: 1,
        fetchedCount: 1,
      }),
    );
    const observations = await createMarketCollectionRepository(
      pool,
    ).listObservations(target.id);
    expect(observations[0]?.listings[0]).toHaveProperty('price', null);
    expect(compareMarketObservations(observations)[0]?.median).toBeNull();
    const manager = new MarketCollectionManager({
      adapter: createReplayMarketCollectionSource([]),
      store: repository,
    });
    const api = buildApi(
      pino({ level: 'silent' }),
      async () => {},
      async () => ({ active: null, published: null }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        marketResearch: targets,
        marketCollection: { manager, store: repository },
      },
    );
    try {
      const response = await api.inject(
        `/api/market/targets/${target.id}/collection`,
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().data.series[0].points[0].median).toBeNull();
    } finally {
      await api.close();
    }
  });

  it.each([
    'succeeded',
    'empty',
    'cancelled',
    'rate_limited',
    'failed',
    'blocked',
  ] as const)(
    'recovers %s raw rows after snapshot publication rolls back',
    async (status) => {
      const now = new Date();
      const fixture = beltDemoFixture(now);
      const target = await targets.saveTarget(
        createMarketTarget(fixture.target, now),
      );
      const input = {
        ...fixture.observation(target.id),
        listings:
          status === 'empty' ? [] : fixture.observation(target.id).listings,
      };
      const run = marketCollectionRunSchema.parse({
        ...makeRun(target.digest, target.id, status),
        coverage:
          status === 'succeeded' || status === 'empty' ? 'complete' : 'partial',
        errorCode:
          status === 'rate_limited'
            ? 'PROVIDER_RATE_LIMITED'
            : status === 'failed'
              ? 'PROVIDER_RESPONSE_INVALID'
              : status === 'blocked'
                ? 'PROVIDER_ACCESS_DENIED'
                : null,
        cancelRequested: status === 'cancelled',
        league: target.league,
        patch: target.patch,
        currency: input.currency,
        capturedAt: input.capturedAt,
        sourceUrl: input.sourceUrl,
        listings: input.listings.map((listing) => ({
          ...listing,
          fingerprint: 'f'.repeat(64),
        })),
        listingCount: input.listings.length,
        returnedCount: input.listings.length,
        fetchedCount: input.listings.length,
        reportedTotal: input.listings.length,
      });
      await pool.query(`create function reject_collection_snapshot_test() returns trigger language plpgsql as $$
      begin raise exception 'synthetic publication failure'; end $$`);
      await pool.query(`create trigger reject_collection_snapshot_test before insert on market_research_snapshots
      for each row execute function reject_collection_snapshot_test()`);
      try {
        const saved = await repository.saveRun(run);
        expect(saved).toMatchObject({
          status: status === 'blocked' ? 'blocked' : 'failed',
          errorCode:
            status === 'blocked'
              ? run.errorCode
              : 'MARKET_COLLECTION_PUBLICATION_FAILED',
          publicationResult: { status, errorCode: run.errorCode },
          snapshotId: null,
          listings: run.listings,
        });
        expect(
          await createMarketCollectionRepository(pool).findRun(run.id),
        ).toEqual(saved);
        expect(await targets.listSnapshots()).toHaveLength(0);
      } finally {
        await pool.query(
          'drop trigger reject_collection_snapshot_test on market_research_snapshots',
        );
        await pool.query('drop function reject_collection_snapshot_test()');
      }
      const reopenedPool = createDatabasePool(config);
      try {
        const reopened = createMarketCollectionRepository(reopenedPool);
        await Promise.all([
          reopened.recoverRunningRuns(new Date().toISOString()),
          repository.saveRun({ ...run, listings: [] }),
        ]);
        const restored = await reopened.findRun(run.id);
        expect(restored).toMatchObject({
          status,
          errorCode: run.errorCode,
          cancelRequested: run.cancelRequested,
          listings: run.listings,
        });
        expect(restored?.snapshotId).toBeTruthy();
        expect(
          (await targets.findSnapshot(restored!.snapshotId!))?.listings,
        ).toEqual(input.listings);
        await reopened.recoverRunningRuns(new Date().toISOString());
        expect(await targets.listSnapshots()).toHaveLength(1);
      } finally {
        await reopenedPool.end();
      }
    },
  );

  it('does not publish a collected row against a different profile digest', async () => {
    const now = new Date();
    const fixture = beltDemoFixture(now);
    const target = await targets.saveTarget(
      createMarketTarget(fixture.target, now),
    );
    const input = fixture.observation(target.id);
    const saved = await repository.saveRun(
      marketCollectionRunSchema.parse({
        ...makeRun('f'.repeat(64), target.id, 'succeeded'),
        league: target.league,
        patch: target.patch,
        currency: input.currency,
        capturedAt: input.capturedAt,
        sourceUrl: input.sourceUrl,
        listings: input.listings.map((listing) => ({
          ...listing,
          fingerprint: 'f'.repeat(64),
        })),
        listingCount: input.listings.length,
        returnedCount: input.listings.length,
        fetchedCount: input.listings.length,
      }),
    );
    expect(saved).toMatchObject({ status: 'failed', snapshotId: null });
    expect(saved.listings).toHaveLength(5);
    expect(await targets.listSnapshots()).toHaveLength(0);
  });

  it.each([
    'PROVIDER_AUTH_FAILED',
    'PROVIDER_ACCESS_DENIED',
    'PROVIDER_CHALLENGE',
  ])(
    'keeps source denial %s after repository reopen and later successful runs',
    async (errorCode) => {
      const target = await targets.saveTarget(makeTarget());
      await repository.saveRun({
        ...makeRun(target.digest, target.id, 'blocked'),
        errorCode,
      });
      const reopened = createMarketCollectionRepository(pool);
      expect(await reopened.isSourceBlocked('fixture-replay')).toBe(true);
      await repository.saveRun(makeRun(target.digest, target.id, 'empty'));
      expect(await reopened.isSourceBlocked('fixture-replay')).toBe(true);
      expect(await reopened.isSourceBlocked('unrelated-source')).toBe(false);
    },
  );

  it.each([{ paused: true }, { enabled: false }])(
    'checks fresh PostgreSQL settings after a shared detail permit wait: %j',
    async (change) => {
      await pool.query(
        'truncate rate_limit_endpoint_policies, rate_limit_states',
      );
      let now = new Date();
      const target = await targets.saveTarget(makeTarget());
      let reachedWait!: () => void;
      let releasePermit!: () => void;
      const waiting = new Promise<void>((resolve) => {
        reachedWait = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releasePermit = resolve;
      });
      const gate = new GggRateLimitController({
        repository: createPostgresRepositories(pool).rateLimits,
        clock: () => now,
        sleep: async (milliseconds) => {
          reachedWait();
          await released;
          now = new Date(now.getTime() + milliseconds);
        },
      });
      const details = vi.fn(async () => ({
        cached: false,
        status: 200,
        headers: new Headers(),
        data: [{ externalId: 'fixture-id', price: 5, item: {} }],
      }));
      const adapter = createBatchedMarketCollectionSource({
        descriptor: {
          id: 'fixture-replay',
          name: 'Test fixture',
          access: 'replay',
          dataKind: 'demo',
          reason: null,
        },
        rateLimits: gate,
        transport: {
          async search() {
            return {
              cached: false,
              status: 200,
              headers: new Headers(),
              data: {
                capturedAt: now.toISOString(),
                coverage: 'complete',
                currency: 'chaos',
                ids: ['fixture-id'],
                queryId: 'fixture-query',
                reportedTotal: 1,
              },
            };
          },
          fetchDetails: details,
        },
      });
      const manager = new MarketCollectionManager({
        adapter,
        store: repository,
        clock: () => now,
      });
      try {
        await manager.updateSettings(target.id, { enabled: true });
        const run = await manager.runNow(target.id);
        await waiting;
        const otherProcess = createMarketCollectionRepository(pool);
        const settings = (await otherProcess.findSettings(target.id))!;
        await otherProcess.saveSettings({
          ...settings,
          ...change,
          nextRunAt: null,
        });
        releasePermit();
        await vi.waitFor(async () => {
          expect((await repository.findRun(run.id))?.status).toBe('cancelled');
        });
        expect(details).not.toHaveBeenCalled();
      } finally {
        releasePermit();
        await manager.stop();
      }
    },
  );

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
    const observations = await createMarketCollectionRepository(
      pool,
    ).listObservations(target.id);
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
      snapshotId: null,
    });

    const abandoned = {
      ...makeRun(target.digest, target.id),
      startedAt: '2026-10-30T09:00:00.000Z',
    };
    await reopened.saveRun(abandoned);
    const checkpoint = await reopened.saveRun({
      ...abandoned,
      coverage: 'partial',
      currency: 'chaos',
      sourceUrl: 'https://example.com/checkpoint-fixture',
      capturedAt: abandoned.startedAt,
      batchCount: 1,
      listingCount: 1,
      fetchedCount: 1,
      returnedCount: 25,
      reportedTotal: 25,
      listings: [
        {
          externalId: 'checkpoint-listing',
          price: 7,
          item: { name: 'raw checkpoint item' },
          rawListing: {
            id: 'checkpoint-listing',
            price: { amount: 7, currency: 'chaos' },
          },
          fingerprint: 'e'.repeat(64),
        },
      ],
      searchEvidence: {
        ids: ['checkpoint-listing'],
        queryId: 'fixture-query',
        reportedTotal: 25,
        raw: { total: 25, result: ['checkpoint-listing'] },
      },
    });
    expect(checkpoint).toMatchObject({ status: 'running', snapshotId: null });
    expect(await targets.listSnapshots()).toHaveLength(0);

    await reopened.recoverRunningRuns('2026-10-30T10:10:00.000Z');
    await expect(
      createMarketCollectionRepository(pool).findRun(abandoned.id),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'MARKET_COLLECTION_INTERRUPTED',
      completedAt: '2026-10-30T10:10:00.000Z',
      listings: checkpoint.listings,
      searchEvidence: checkpoint.searchEvidence,
      snapshotId: expect.any(String),
      coverage: 'partial',
    });
    const recovered = await reopened.findRun(abandoned.id);
    expect(
      (await targets.findSnapshot(recovered!.snapshotId!))?.listings[0]
        ?.rawListing,
    ).toEqual(checkpoint.listings[0]?.rawListing);
    expect(await targets.listSnapshots()).toHaveLength(1);
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
