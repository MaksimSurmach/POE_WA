import type { MarketEconomyAttempt } from '@poe-worksmith/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  collectRecipeMaterialPrices,
  summarizeEconomy,
  type MarketEconomyRepository,
  type StoredMarketEconomySnapshot,
} from './marketEconomy.js';
import {
  NinjaEconomyClient,
  type NinjaEconomyFetch,
} from './providers/ninjaEconomy.js';

// Synthetic public-response fixtures; these amounts are not live market evidence.
const exchange = {
  core: { primary: 'chaos', items: [{ id: 'chaos', name: 'Chaos Orb' }] },
  items: [{ id: 'synthetic', name: 'Synthetic Material' }],
  lines: [{ id: 'synthetic', primaryValue: 2, volumePrimaryValue: 10 }],
};
const now = new Date('2026-11-02T12:00:00.000Z');
const userAgent = 'poe-worksmith-test/0.1 (contact: test@example.com)';
function memoryEconomyRepository() {
  const snapshots = new Map<string, StoredMarketEconomySnapshot>();
  const attempts = new Map<string, MarketEconomyAttempt>();
  const repository: MarketEconomyRepository = {
    async assertReady() {},
    async list() {
      return [...snapshots.values()].map(summarizeEconomy);
    },
    async latest(league, category) {
      const snapshot = [...snapshots.values()]
        .reverse()
        .find((s) => s.league === league && s.category === category);
      return snapshot ? summarizeEconomy(snapshot) : null;
    },
    async save(snapshot) {
      snapshots.set(snapshot.id, snapshot);
      return snapshot;
    },
    async find(id) {
      return snapshots.get(id) ?? null;
    },
    async listAttempts() {
      return [...attempts.values()];
    },
    async saveAttempt(attempt) {
      attempts.set(attempt.id, attempt);
    },
  };
  return repository;
}
afterEach(() => vi.restoreAllMocks());

describe('bounded economy/material refresh', () => {
  it('collects four categories and journals actual progress through the public Ninja client', async () => {
    const fetch = vi.fn<NinjaEconomyFetch>(async () => Response.json(exchange));
    const client = new NinjaEconomyClient({ fetch, userAgent, now: () => now });
    const repository = memoryEconomyRepository();
    const progress: Array<Record<string, unknown>> = [];
    const report = await collectRecipeMaterialPrices(
      'Synthetic League',
      client,
      repository,
      undefined,
      async (value) => {
        progress.push({ ...value });
      },
    );
    expect(report).toMatchObject({
      total: 4,
      succeeded: 4,
      failed: 0,
      sourceFreshness: now.toISOString(),
      cooldownUntil: null,
      errorCode: null,
    });
    expect(
      fetch.mock.calls.map(([url]) => new URL(url).searchParams.get('type')),
    ).toEqual(['Currency', 'Essence', 'Fossil', 'Resonator']);
    expect(await repository.list()).toHaveLength(4);
    expect(await repository.listAttempts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'succeeded',
          cacheStatus: 'fetched',
          completedAt: expect.any(String),
          snapshotId: expect.any(String),
        }),
      ]),
    );
    expect(
      (await repository.listAttempts()).every(
        (attempt) => attempt.status === 'succeeded',
      ),
    ).toBe(true);
    expect(progress.map((value) => value.succeeded)).toEqual([0, 1, 2, 3, 4]);
  });

  it('reports four failures and the shared cooldown after one HTTP 429, with no false success', async () => {
    const fetch = vi.fn<NinjaEconomyFetch>(
      async () =>
        new Response(null, { status: 429, headers: { 'Retry-After': '120' } }),
    );
    const client = new NinjaEconomyClient({ fetch, userAgent, now: () => now });
    const repository = memoryEconomyRepository();
    const report = await collectRecipeMaterialPrices(
      'Synthetic League',
      client,
      repository,
    );
    expect(report).toMatchObject({
      total: 4,
      succeeded: 0,
      failed: 4,
      sourceFreshness: null,
      errorCode: 'RATE_LIMITED',
      cooldownUntil: '2026-11-02T12:02:00.000Z',
    });
    expect(client.cooldownUntil).toBe(report.cooldownUntil);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await repository.list()).toEqual([]);
    expect(await repository.listAttempts()).toHaveLength(4);
    expect(
      (await repository.listAttempts()).every(
        (attempt) =>
          attempt.status === 'failed' && attempt.errorCode === 'RATE_LIMITED',
      ),
    ).toBe(true);
  });

  it('finishes the current category and stops before the next when cancellation is requested', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<NinjaEconomyFetch>(async () => {
      controller.abort(new Error('operator cancellation'));
      return Response.json(exchange);
    });
    const client = new NinjaEconomyClient({ fetch, userAgent, now: () => now });
    const repository = memoryEconomyRepository();
    await expect(
      collectRecipeMaterialPrices(
        'Synthetic League',
        client,
        repository,
        controller.signal,
      ),
    ).rejects.toThrow('operator cancellation');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await repository.list()).toHaveLength(1);
    expect(await repository.listAttempts()).toEqual([
      expect.objectContaining({ category: 'Currency', status: 'succeeded' }),
    ]);
  });

  it('uses the latest timeout callback on every new HTTP request', async () => {
    let timeoutMs = 1000;
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const readTimeoutMs = vi.fn(async () => timeoutMs);
    const fetch = vi.fn<NinjaEconomyFetch>(async () => Response.json(exchange));
    const client = new NinjaEconomyClient({
      fetch,
      userAgent,
      now: () => now,
      readTimeoutMs,
    });
    await client.fetchSnapshot({
      league: 'Synthetic League',
      category: 'Currency',
    });
    timeoutMs = 20_000;
    await client.fetchSnapshot({
      league: 'Synthetic League',
      category: 'Essence',
    });
    expect(readTimeoutMs).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenNthCalledWith(1, 1000);
    expect(timeout).toHaveBeenNthCalledWith(2, 20_000);
    expect(
      fetch.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal),
    ).toBe(true);
  });
});
