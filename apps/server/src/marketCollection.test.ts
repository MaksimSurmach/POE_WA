import { describe, expect, it } from 'vitest';

import {
  compareMarketObservations,
  createBatchedMarketCollectionSource,
  createReplayMarketCollectionSource,
  MarketCollectionManager,
  type MarketCollectionAdapter,
  type MarketCollectionBatch,
  type MarketCollectionObservation,
  type MarketCollectionStore,
} from './marketCollection.js';
import { createMarketTarget } from './marketResearch.js';
import { DomainError } from '@poe-worksmith/domain';
import pino from 'pino';
import type { RateLimitGate } from './rateLimitController.js';
import { buildApi } from './api.js';
import type {
  MarketCollectionRun,
  MarketCollectionSettings,
} from '@poe-worksmith/contracts';

const scope = {
  targetId: 'a0000000-0000-4000-8000-000000000001',
  targetDigest: 'a'.repeat(64),
  queryDigest: 'b'.repeat(64),
  league: 'Test League',
  patch: '3.29',
};

function observation(
  id: string,
  at: string,
  listings: MarketCollectionObservation['listings'],
  overrides: Partial<MarketCollectionObservation> = {},
): MarketCollectionObservation {
  return {
    ...scope,
    id: `b0000000-0000-4000-8000-${id.padStart(12, '0')}`,
    status: listings.length === 0 ? 'empty' : 'succeeded',
    dataKind: 'observed',
    coverage: 'complete',
    currency: 'chaos',
    listings,
    startedAt: at,
    capturedAt: at,
    cached: false,
    ...overrides,
  };
}

const listing = (externalId: string, price: number) => ({
  externalId,
  price,
  item: { name: externalId },
});

describe('managed market observation comparison', () => {
  it('separates first-seen, changed, missing and returned listings', () => {
    const points = compareMarketObservations([
      observation('1', '2026-10-30T10:00:00.000Z', [
        listing('alpha', 10),
        listing('beta', 20),
      ]),
      observation('2', '2026-10-30T10:05:00.000Z', [
        listing('beta', 21),
        listing('gamma', 5),
      ]),
      observation('3', '2026-10-30T10:10:00.000Z', [
        listing('alpha', 10),
        listing('beta', 21),
        listing('gamma', 5),
      ]),
    ]);

    expect(
      points.map(({ newCount, changedCount, missing, restored }) => ({
        newCount,
        changedCount,
        missing,
        restored,
      })),
    ).toEqual([
      { newCount: 2, changedCount: 0, missing: [], restored: [] },
      {
        newCount: 1,
        changedCount: 1,
        missing: ['alpha'],
        restored: [],
      },
      { newCount: 0, changedCount: 0, missing: [], restored: ['alpha'] },
    ]);
  });

  it('does not turn partial or cached results into independent observations', () => {
    const points = compareMarketObservations([
      observation('1', '2026-10-30T10:00:00.000Z', [listing('alpha', 10)]),
      observation('2', '2026-10-30T10:05:00.000Z', [listing('beta', 5)], {
        coverage: 'partial',
      }),
      observation('3', '2026-10-30T10:07:00.000Z', [listing('beta', 5)], {
        cached: true,
        capturedAt: '2026-10-30T10:05:00.000Z',
      }),
      observation('4', '2026-10-30T10:10:00.000Z', [listing('alpha', 10)]),
    ]);

    expect(points[1]).toMatchObject({ newCount: 0, missingCount: 0 });
    expect(points[2]).toMatchObject({
      capturedAt: '2026-10-30T10:05:00.000Z',
      newCount: 0,
      missingCount: 0,
    });
    expect(points[3]).toMatchObject({ newCount: 0, restored: [] });
  });

  it('rejects cross-query comparisons', () => {
    expect(() =>
      compareMarketObservations([
        observation('1', '2026-10-30T10:00:00.000Z', []),
        observation('2', '2026-10-30T10:05:00.000Z', [], {
          queryDigest: 'c'.repeat(64),
        }),
      ]),
    ).toThrow('Market observations must share one profile scope');
  });
});

describe('managed collection runner', () => {
  const target = createMarketTarget({
    name: 'Test belt',
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

  function makeStore(): MarketCollectionStore & {
    runs: Map<string, MarketCollectionRun>;
  } {
    const runs = new Map<string, MarketCollectionRun>();
    let settings: MarketCollectionSettings | null = null;
    return {
      runs,
      findTarget: async (id) => (id === target.id ? target : null),
      findSettings: async () => settings,
      listSettings: async () => (settings ? [settings] : []),
      saveSettings: async (row) => (settings = row),
      claimScheduledSettings: async (row, dueAt) => {
        if (
          !settings?.enabled ||
          settings.paused ||
          settings.nextRunAt !== dueAt
        )
          return false;
        settings = row;
        return true;
      },
      findRun: async (id) => runs.get(id) ?? null,
      listRuns: async (id, limit) =>
        [...runs.values()]
          .filter((run) => run.targetId === id)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, limit),
      listObservations: async (id) =>
        [...runs.values()]
          .filter((run) => run.targetId === id)
          .map((run) => ({
            ...run,
            listings: run.listings.map((listing) => ({
              ...(listing.externalId ? { externalId: listing.externalId } : {}),
              fingerprint: listing.fingerprint,
              price: listing.price,
              item: listing.item,
            })),
          })),
      saveRun: async (row) => {
        if (
          row.status === 'running' &&
          [...runs.values()].some(
            (run) => run.targetId === row.targetId && run.status === 'running',
          )
        )
          throw new Error('active run conflict');
        runs.set(row.id, row);
        return row;
      },
      requestCancel: async (id) => {
        const run = runs.get(id);
        if (!run) return null;
        const cancelled = { ...run, cancelRequested: true };
        runs.set(id, cancelled);
        return cancelled;
      },
      recoverRunningRuns: async (_at, activeRunIds = []) => {
        const cancelled: string[] = [];
        for (const [id, run] of runs)
          if (run.status === 'running' && activeRunIds.includes(id)) {
            if (run.cancelRequested) cancelled.push(id);
          } else if (run.status === 'running')
            runs.set(id, {
              ...run,
              status: 'failed',
              errorCode: 'MARKET_COLLECTION_INTERRUPTED',
            });
        return cancelled;
      },
    };
  }

  async function waitUntilDone(
    store: ReturnType<typeof makeStore>,
    id: string,
  ) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const run = store.runs.get(id);
      if (run && run.status !== 'running') return run;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('collection did not finish');
  }

  const fixture: MarketCollectionBatch = {
    batchCount: 1,
    cached: false,
    capturedAt: '2026-10-30T10:00:00.000Z',
    coverage: 'complete',
    currency: 'chaos',
    fetchedCount: 1,
    listings: [listing('alpha', 10)],
    reportedTotal: 1,
    returnedCount: 1,
  };

  it('stores sequential replay snapshots and marks a repeated response as cached', async () => {
    const store = makeStore();
    const manager = new MarketCollectionManager({
      adapter: createReplayMarketCollectionSource([fixture]),
      clock: () => new Date('2026-10-30T10:05:00.000Z'),
      store,
    });
    const first = await manager.runNow(target.id);
    const firstDone = await waitUntilDone(store, first.id);
    const second = await manager.runNow(target.id);
    const secondDone = await waitUntilDone(store, second.id);
    const completed = [firstDone, secondDone];

    expect(completed.map((run) => run.status)).toEqual([
      'succeeded',
      'succeeded',
    ]);
    expect(completed.map((run) => run.dataKind)).toEqual(['demo', 'demo']);
    expect(completed.map((run) => run.cached)).toEqual([false, true]);
    expect(completed.map((run) => run.capturedAt)).toEqual([
      fixture.capturedAt,
      fixture.capturedAt,
    ]);
    expect(store.runs.size).toBe(2);
  });

  it('fetches detail pages sequentially through the shared rate gate and caps at 1,000', async () => {
    const ids = Array.from({ length: 1001 }, (_, index) => `listing-${index}`);
    const waits: string[] = [];
    const observed: string[] = [];
    const batchSizes: number[] = [];
    const rateLimits = {
      async waitForPermit(endpoint: string, signal?: AbortSignal) {
        expect(signal?.aborted).toBe(false);
        waits.push(endpoint);
        return {};
      },
      async observeResponse(endpoint: string) {
        observed.push(endpoint);
        return {};
      },
    } as unknown as RateLimitGate;
    const source = createBatchedMarketCollectionSource({
      descriptor: {
        id: 'fixture-transport',
        name: 'fixture',
        access: 'authorized',
        dataKind: 'observed',
        reason: null,
      },
      rateLimits,
      transport: {
        async search() {
          return {
            cached: false,
            data: {
              capturedAt: '2026-10-30T10:00:00.000Z',
              coverage: 'complete',
              currency: 'chaos',
              ids,
              queryId: 'fixture-query',
              reportedTotal: 2000,
            },
            headers: new Headers(),
            status: 200,
          };
        },
        async fetchDetails({ ids: page }) {
          batchSizes.push(page.length);
          return {
            cached: false,
            data: page.map((externalId) => ({
              externalId,
              price: 10,
              item: { name: externalId },
            })),
            headers: new Headers(),
            status: 200,
          };
        },
      },
    });

    const result = await source.collect({
      target,
      signal: new AbortController().signal,
    });

    expect(batchSizes).toHaveLength(100);
    expect(batchSizes.every((size) => size === 10)).toBe(true);
    expect(waits).toHaveLength(101);
    expect(observed).toEqual(waits);
    expect(result).toMatchObject({
      batchCount: 100,
      coverage: 'partial',
      fetchedCount: 1000,
      returnedCount: 1001,
      listings: expect.arrayContaining([
        expect.objectContaining({ externalId: 'listing-999' }),
      ]),
    });
  });

  it('persists completed detail pages when a later fetch hits a rate limit', async () => {
    const store = makeStore();
    const ids = Array.from({ length: 11 }, (_, index) => `rate-${index}`);
    let fetchCount = 0;
    const source = createBatchedMarketCollectionSource({
      descriptor: {
        id: 'rate-limited-transport',
        name: 'fixture',
        access: 'authorized',
        dataKind: 'observed',
        reason: null,
      },
      rateLimits: {
        async waitForPermit() {
          return {};
        },
        async observeResponse() {
          return {};
        },
      } as unknown as RateLimitGate,
      transport: {
        async search() {
          return {
            cached: false,
            data: {
              capturedAt: '2026-10-30T10:00:00.000Z',
              coverage: 'complete',
              currency: 'chaos',
              ids,
              queryId: 'rate-query',
              reportedTotal: 11,
            },
            headers: new Headers(),
            status: 200,
          };
        },
        async fetchDetails({ ids: page }) {
          fetchCount += 1;
          if (fetchCount === 2)
            return {
              cached: false,
              data: [],
              headers: new Headers({ 'retry-after': '60' }),
              status: 429,
            };
          return {
            cached: false,
            data: page.map((externalId) => ({
              externalId,
              price: 10,
              item: { name: externalId },
            })),
            headers: new Headers(),
            status: 200,
          };
        },
      },
    });
    const manager = new MarketCollectionManager({ adapter: source, store });
    const run = await manager.runNow(target.id);

    await expect(waitUntilDone(store, run.id)).resolves.toMatchObject({
      status: 'rate_limited',
      coverage: 'partial',
      returnedCount: 11,
      fetchedCount: 10,
      listingCount: 10,
      errorCode: 'PROVIDER_RATE_LIMITED',
    });
  });

  it('rejects detail rows whose identifiers were not requested', async () => {
    const store = makeStore();
    const source = createBatchedMarketCollectionSource({
      descriptor: {
        id: 'mismatched-transport',
        name: 'fixture',
        access: 'authorized',
        dataKind: 'observed',
        reason: null,
      },
      rateLimits: {
        async waitForPermit() {
          return {};
        },
        async observeResponse() {
          return {};
        },
      } as unknown as RateLimitGate,
      transport: {
        async search() {
          return {
            cached: false,
            data: {
              capturedAt: '2026-10-30T10:00:00.000Z',
              coverage: 'complete',
              currency: 'chaos',
              ids: ['requested-id'],
              queryId: 'mismatch-query',
              reportedTotal: 1,
            },
            headers: new Headers(),
            status: 200,
          };
        },
        async fetchDetails() {
          return {
            cached: false,
            data: [
              {
                externalId: 'foreign-id',
                price: 10,
                item: { name: 'fixture' },
              },
            ],
            headers: new Headers(),
            status: 200,
          };
        },
      },
    });
    const manager = new MarketCollectionManager({ adapter: source, store });
    const run = await manager.runNow(target.id);

    await expect(waitUntilDone(store, run.id)).resolves.toMatchObject({
      status: 'failed',
      coverage: 'partial',
      listingCount: 0,
      errorCode: 'PROVIDER_RESPONSE_INVALID',
    });
  });

  it('does not send requests already waiting when another request is denied access', async () => {
    let secondWaitStarted!: () => void;
    let releaseSecondWait!: () => void;
    let releaseHeaderWrite!: () => void;
    const secondWaiting = new Promise<void>((resolve) => {
      secondWaitStarted = resolve;
    });
    const secondPermit = new Promise<void>((resolve) => {
      releaseSecondWait = resolve;
    });
    const headerWrite = new Promise<void>((resolve) => {
      releaseHeaderWrite = resolve;
    });
    let waits = 0;
    let requests = 0;
    const source = createBatchedMarketCollectionSource({
      descriptor: {
        id: 'concurrent-access-check',
        name: 'fixture',
        access: 'authorized',
        dataKind: 'observed',
        reason: null,
      },
      rateLimits: {
        async waitForPermit() {
          waits += 1;
          if (waits === 2) {
            secondWaitStarted();
            await secondPermit;
          }
          return {};
        },
        async observeResponse(_endpoint: string, response: { status: number }) {
          if (response.status === 403) {
            releaseSecondWait();
            await headerWrite;
          }
          return {};
        },
      } as unknown as RateLimitGate,
      transport: {
        async search() {
          requests += 1;
          await secondWaiting;
          return {
            cached: false,
            data: {
              capturedAt: null,
              coverage: 'complete',
              currency: 'chaos' as const,
              ids: [],
              queryId: null,
              reportedTotal: 0,
            },
            headers: new Headers(),
            status: 403,
          };
        },
        async fetchDetails() {
          throw new Error('should not fetch');
        },
      },
    });
    const collect = () =>
      source.collect({ target, signal: new AbortController().signal });

    const results = await Promise.allSettled([
      collect(),
      collect().finally(releaseHeaderWrite),
    ]);

    expect(requests).toBe(1);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
  });

  it('preserves cached fixture provenance on the first replay', async () => {
    const store = makeStore();
    const manager = new MarketCollectionManager({
      adapter: createReplayMarketCollectionSource([
        { ...fixture, cached: true },
      ]),
      store,
    });
    const run = await manager.runNow(target.id);

    await expect(waitUntilDone(store, run.id)).resolves.toMatchObject({
      cached: true,
      status: 'succeeded',
    });
  });

  it('persists authentication denial as blocked without retaining credentials', async () => {
    const store = makeStore();
    const manager = new MarketCollectionManager({
      adapter: {
        descriptor: {
          id: 'test-provider',
          name: 'test',
          access: 'authorized',
          dataKind: 'observed',
          reason: null,
        },
        async collect() {
          throw new DomainError('PROVIDER_AUTH_FAILED');
        },
      },
      store,
    });
    const run = await manager.runNow(target.id);

    await expect(waitUntilDone(store, run.id)).resolves.toMatchObject({
      status: 'blocked',
      errorCode: 'PROVIDER_AUTH_FAILED',
      listings: [],
    });
  });

  it('preserves completed detail rows when cancellation races collection completion', async () => {
    const store = makeStore();
    let collecting!: () => void;
    let finishCollection!: () => void;
    const started = new Promise<void>((resolve) => {
      collecting = resolve;
    });
    const release = new Promise<void>((resolve) => {
      finishCollection = resolve;
    });
    const manager = new MarketCollectionManager({
      adapter: {
        descriptor: {
          id: 'cancel-race',
          name: 'fixture',
          access: 'authorized',
          dataKind: 'observed',
          reason: null,
        },
        async collect() {
          collecting();
          await release;
          return { ...fixture, listings: [listing('already-fetched', 12)] };
        },
      },
      store,
    });
    const run = await manager.runNow(target.id);
    await started;
    await manager.cancel(run.id);
    finishCollection();

    await expect(waitUntilDone(store, run.id)).resolves.toMatchObject({
      status: 'cancelled',
      coverage: 'partial',
      listingCount: 1,
      listings: [expect.objectContaining({ externalId: 'already-fetched' })],
    });
  });

  it('aborts a local collection after another manager requests cancellation', async () => {
    const store = makeStore();
    let collecting!: () => void;
    const started = new Promise<void>((resolve) => {
      collecting = resolve;
    });
    const manager = new MarketCollectionManager({
      adapter: {
        descriptor: {
          id: 'remote-cancel',
          name: 'fixture',
          access: 'authorized',
          dataKind: 'observed',
          reason: null,
        },
        async collect({ signal }) {
          collecting();
          return await new Promise<MarketCollectionBatch>((resolve) => {
            signal.addEventListener(
              'abort',
              () =>
                resolve({
                  ...fixture,
                  cancelled: true,
                  coverage: 'partial',
                  listings: [listing('before-cancel', 9)],
                }),
              { once: true },
            );
          });
        },
      },
      store,
    });
    const run = await manager.runNow(target.id);
    await started;
    await store.requestCancel(run.id);
    await manager.tick();

    await expect(waitUntilDone(store, run.id)).resolves.toMatchObject({
      status: 'cancelled',
      coverage: 'partial',
      listingCount: 1,
      listings: [expect.objectContaining({ externalId: 'before-cancel' })],
    });
  });

  it('blocks the source after one access denial instead of repeating the request', async () => {
    const store = makeStore();
    let attempts = 0;
    const manager = new MarketCollectionManager({
      adapter: {
        descriptor: {
          id: 'access-controlled-source',
          name: 'test',
          access: 'authorized',
          dataKind: 'observed',
          reason: null,
        },
        async collect() {
          attempts += 1;
          throw new DomainError('PROVIDER_AUTH_FAILED');
        },
      },
      store,
    });
    const first = await manager.runNow(target.id);
    await expect(waitUntilDone(store, first.id)).resolves.toMatchObject({
      status: 'blocked',
    });
    expect(manager.source.access).toBe('blocked');

    const second = await manager.runNow(target.id);
    await expect(waitUntilDone(store, second.id)).resolves.toMatchObject({
      status: 'blocked',
      errorCode: 'MARKET_ACCESS_BLOCKED',
    });
    expect(attempts).toBe(1);
  });

  it('separates rate limits, partial coverage and empty successful results', async () => {
    const outcomes: Array<{
      adapter: MarketCollectionAdapter;
      status: string;
    }> = [];
    const blocked = {
      descriptor: {
        id: 'rate-limited',
        name: 'test',
        access: 'authorized' as const,
        dataKind: 'observed' as const,
        reason: null,
      },
      async collect() {
        throw new DomainError('PROVIDER_RATE_LIMITED');
      },
    };
    const partial = {
      descriptor: {
        id: 'bounded',
        name: 'test',
        access: 'authorized' as const,
        dataKind: 'observed' as const,
        reason: null,
      },
      async collect() {
        return { ...fixture, coverage: 'partial' as const };
      },
    };
    const empty = {
      descriptor: {
        id: 'empty',
        name: 'test',
        access: 'authorized' as const,
        dataKind: 'observed' as const,
        reason: null,
      },
      async collect() {
        return {
          ...fixture,
          coverage: 'complete' as const,
          currency: null,
          listings: [],
          reportedTotal: 0,
          returnedCount: 0,
          fetchedCount: 0,
        };
      },
    };
    outcomes.push(
      { adapter: blocked, status: 'rate_limited' },
      { adapter: partial, status: 'partial' },
      { adapter: empty, status: 'empty' },
    );

    for (const [index, outcome] of outcomes.entries()) {
      const store = makeStore();
      const manager = new MarketCollectionManager({
        adapter: outcome.adapter,
        clock: () =>
          new Date(`2026-10-30T10:${String(index).padStart(2, '0')}:00.000Z`),
        store,
      });
      const run = await manager.runNow(target.id);
      await expect(waitUntilDone(store, run.id)).resolves.toMatchObject({
        status: outcome.status,
      });
    }
  });

  it('caps a provider response without claiming complete coverage', async () => {
    const store = makeStore();
    const listings = Array.from({ length: 1100 }, (_, index) =>
      listing(`listing-${index}`, index + 1),
    );
    const manager = new MarketCollectionManager({
      adapter: {
        descriptor: {
          id: 'bounded',
          name: 'test',
          access: 'authorized',
          dataKind: 'observed',
          reason: null,
        },
        async collect() {
          return {
            ...fixture,
            batchCount: 11,
            listings,
            returnedCount: listings.length,
            fetchedCount: listings.length,
            reportedTotal: listings.length,
          };
        },
      },
      store,
    });
    const run = await manager.runNow(target.id);

    await expect(waitUntilDone(store, run.id)).resolves.toMatchObject({
      status: 'partial',
      coverage: 'partial',
      batchCount: 11,
      listingCount: 1000,
      listings: expect.arrayContaining([
        expect.objectContaining({ externalId: 'listing-999' }),
      ]),
    });
  });

  it('marks missing detail fetches partial even when search coverage says complete', async () => {
    const store = makeStore();
    const manager = new MarketCollectionManager({
      adapter: {
        descriptor: {
          id: 'detail-fetch',
          name: 'test',
          access: 'authorized',
          dataKind: 'observed',
          reason: null,
        },
        async collect() {
          return {
            ...fixture,
            batchCount: 1,
            coverage: 'complete',
            returnedCount: 50,
            fetchedCount: 10,
            reportedTotal: 50,
          };
        },
      },
      store,
    });
    const run = await manager.runNow(target.id);

    await expect(waitUntilDone(store, run.id)).resolves.toMatchObject({
      status: 'partial',
      coverage: 'partial',
      returnedCount: 50,
      fetchedCount: 10,
    });
  });

  it('marks omitted fetched items partial instead of claiming full coverage', async () => {
    const store = makeStore();
    const manager = new MarketCollectionManager({
      adapter: {
        descriptor: {
          id: 'omitted-detail',
          name: 'test',
          access: 'authorized',
          dataKind: 'observed',
          reason: null,
        },
        async collect() {
          return {
            ...fixture,
            returnedCount: 1,
            fetchedCount: 1,
            listings: [],
          };
        },
      },
      store,
    });
    const run = await manager.runNow(target.id);

    await expect(waitUntilDone(store, run.id)).resolves.toMatchObject({
      status: 'partial',
      coverage: 'partial',
      returnedCount: 1,
      fetchedCount: 1,
      listingCount: 0,
    });
  });

  it('cancels an in-flight source call', async () => {
    const store = makeStore();
    const manager = new MarketCollectionManager({
      adapter: {
        descriptor: {
          id: 'test-provider',
          name: 'test',
          access: 'authorized',
          dataKind: 'observed',
          reason: null,
        },
        async collect({ signal }) {
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          });
          throw new Error('unreachable');
        },
      },
      store,
    });
    const run = await manager.runNow(target.id);

    await manager.cancel(run.id);

    await expect(waitUntilDone(store, run.id)).resolves.toMatchObject({
      status: 'cancelled',
      cancelRequested: false,
    });
  });

  it('waits for cancelled run persistence before shutdown returns', async () => {
    const store = makeStore();
    let enteredSave!: () => void;
    let releaseSave!: () => void;
    const saving = new Promise<void>((resolve) => (enteredSave = resolve));
    const gate = new Promise<void>((resolve) => (releaseSave = resolve));
    const saveRun = store.saveRun;
    store.saveRun = async (run) => {
      if (run.status === 'cancelled') {
        enteredSave();
        await gate;
      }
      return saveRun(run);
    };
    const manager = new MarketCollectionManager({
      adapter: {
        descriptor: {
          id: 'slow-test-provider',
          name: 'test',
          access: 'authorized',
          dataKind: 'observed',
          reason: null,
        },
        async collect({ signal }) {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          throw signal.reason;
        },
      },
      store,
    });
    const run = await manager.runNow(target.id);
    const stopping = manager.stop();
    await saving;
    expect(store.runs.get(run.id)?.status).toBe('running');
    releaseSave();
    await stopping;
    expect(store.runs.get(run.id)?.status).toBe('cancelled');
  });

  it('serves collection settings, replay runs and per-query history through the API', async () => {
    const store = makeStore();
    const manager = new MarketCollectionManager({
      adapter: createReplayMarketCollectionSource([
        fixture,
        {
          ...fixture,
          currency: null,
          listings: [],
          reportedTotal: 0,
          returnedCount: 0,
          fetchedCount: 0,
        },
      ]),
      store,
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
      { marketCollection: { manager, store } },
    );
    try {
      const settings = await api.inject({
        method: 'PUT',
        url: `/api/market/targets/${target.id}/collection/settings`,
        payload: { enabled: true, intervalMinutes: 5 },
      });
      expect(settings.statusCode).toBe(200);
      expect(settings.json().data).toMatchObject({
        enabled: true,
        intervalMinutes: 5,
      });

      const started = await api.inject({
        method: 'POST',
        url: `/api/market/targets/${target.id}/collection/run`,
      });
      expect(started.statusCode).toBe(202);
      const runId = started.json().data.id as string;
      await waitUntilDone(store, runId);
      const empty = await api.inject({
        method: 'POST',
        url: `/api/market/targets/${target.id}/collection/run`,
      });
      await waitUntilDone(store, empty.json().data.id as string);

      const first = store.runs.get(runId)!;
      const start = Date.parse(first.startedAt);
      for (let index = 1; index <= 25; index += 1) {
        const at = new Date(start + index * 60_000).toISOString();
        const id = crypto.randomUUID();
        store.runs.set(id, {
          ...first,
          id,
          status: 'empty',
          coverage: 'complete',
          returnedCount: 0,
          fetchedCount: 0,
          listings: [],
          listingCount: 0,
          currency: null,
          capturedAt: at,
          startedAt: at,
          completedAt: at,
          snapshotId: id,
        });
      }
      const restoredAt = new Date(start + 26 * 60_000).toISOString();
      const restoredId = crypto.randomUUID();
      store.runs.set(restoredId, {
        ...first,
        id: restoredId,
        capturedAt: restoredAt,
        startedAt: restoredAt,
        completedAt: restoredAt,
        snapshotId: restoredId,
      });

      const history = await api.inject({
        method: 'GET',
        url: `/api/market/targets/${target.id}/collection`,
      });
      expect(history.statusCode).toBe(200);
      expect(history.json().data.runs).toHaveLength(25);
      expect(history.json().data.runs[0]).toMatchObject({
        id: restoredId,
        status: 'succeeded',
      });
      expect(history.json().data.series[0]?.points).toHaveLength(28);
      expect(history.json().data.series[0]?.points.at(-1)).toMatchObject({
        count: 1,
        restoredCount: 1,
      });
      expect(history.json().data).toMatchObject({
        settings: { enabled: true, intervalMinutes: 5 },
        source: { access: 'replay', dataKind: 'demo' },
        series: [
          {
            dataKind: 'demo',
            currency: 'chaos',
            queryDigest: expect.any(String),
            points: expect.any(Array),
          },
        ],
      });
    } finally {
      await api.close();
      await manager.stop();
    }
  });
});
