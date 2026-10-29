import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { buildApi } from './api.js';
import {
  summarizeEconomy,
  type MarketEconomyOptions,
  type MarketEconomyRepository,
  type StoredMarketEconomySnapshot,
} from './marketEconomy.js';
import { NinjaEconomyClient } from './providers/ninjaEconomy.js';

function repository(): MarketEconomyRepository {
  const snapshots = new Map<string, StoredMarketEconomySnapshot>();
  return {
    assertReady: async () => {},
    list: async () => [...snapshots.values()].map(summarizeEconomy),
    save: async (snapshot) => {
      const key = `${snapshot.league}:${snapshot.category}:${snapshot.payloadHash}:${snapshot.capturedAt}`;
      const stored = snapshots.get(key) ?? snapshot;
      snapshots.set(key, stored);
      return stored;
    },
    find: async (id) =>
      [...snapshots.values()].find((snapshot) => snapshot.id === id) ?? null,
  };
}

function apiFor(options: MarketEconomyOptions) {
  return buildApi(
    pino({ level: 'silent' }),
    async () => {},
    async () => ({ active: null, published: null }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { marketEconomy: options },
  );
}
const overview = {
  lines: [
    {
      id: 1,
      name: 'Test base',
      detailsId: 'test-base',
      chaosValue: 42,
      count: 8,
      listingCount: 6,
    },
  ],
};

describe('public economy collection API', () => {
  it('does not contact a provider if storage is absent or not ready', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(overview)));
    const client = new NinjaEconomyClient({
      userAgent: 'Worksmith tests (contact: tests@example.com)',
      fetch,
    });
    for (const storage of [
      undefined,
      {
        ...repository(),
        assertReady: async () => {
          throw new Error('migration missing');
        },
      },
    ]) {
      const api = apiFor({ client, repository: storage });
      try {
        const result = await api.inject({
          method: 'POST',
          url: '/api/market/economy/collect',
          payload: { league: 'Example', category: 'BaseType' },
        });
        expect(result.statusCode).toBe(503);
        expect(result.json().error.code).toBe('PERSISTENCE_UNAVAILABLE');
        expect(
          (await api.inject('/api/market/economy/leagues')).statusCode,
        ).toBe(503);
      } finally {
        await api.close();
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('persists one immutable snapshot through cache hits and 304 revalidation, without exposing raw bodies in list/detail', async () => {
    let now = new Date('2026-10-01T00:00:00Z');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(overview), {
          headers: { ETag: '"base-v1"', 'Cache-Control': 'max-age=300' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 304,
          headers: { 'Cache-Control': 'max-age=300' },
        }),
      );
    const client = new NinjaEconomyClient({
      userAgent: 'Worksmith tests (contact: tests@example.com)',
      fetch,
      now: () => now,
    });
    const storage = repository();
    const api = apiFor({ client, repository: storage });
    try {
      const collect = () =>
        api.inject({
          method: 'POST',
          url: '/api/market/economy/collect',
          payload: { league: 'Example', category: 'BaseType' },
        });
      const first = (await collect()).json().data;
      const hit = (await collect()).json().data;
      expect(hit.snapshot.id).toBe(first.snapshot.id);
      expect(hit.cacheStatus).toBe('hit');
      now = new Date('2026-10-01T00:05:00Z');
      const validated = (await collect()).json().data;
      expect(validated.cacheStatus).toBe('revalidated');
      expect(validated.snapshot.id).toBe(first.snapshot.id);
      expect(validated.snapshot.capturedAt).toBe('2026-10-01T00:00:00.000Z');
      expect(validated.checkedAt).toBe('2026-10-01T00:05:00.000Z');
      expect(await storage.list()).toHaveLength(1);
      expect((await storage.find(first.snapshot.id))?.raw).toEqual(overview);
      const list = (await api.inject('/api/market/economy')).json().data;
      expect(list).toMatchObject({
        configured: true,
        storage: 'postgres',
        limit: 100,
      });
      expect(list.snapshots[0]).not.toHaveProperty('raw');
      expect(list.snapshots[0]).not.toHaveProperty('lines');
      const detail = (
        await api.inject(`/api/market/economy/${first.snapshot.id}`)
      ).json().data;
      expect(detail.lines[0].price).toEqual({ amount: 42, currency: 'chaos' });
      expect(detail).not.toHaveProperty('raw');
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await api.close();
    }
  });

  it('distinguishes unconfigured collection, rate limiting and no-store from successful empty data', async () => {
    const unconfigured = apiFor({ repository: repository() });
    try {
      expect(
        (await unconfigured.inject('/api/market/economy')).json().data
          .configured,
      ).toBe(false);
      expect(
        (await unconfigured.inject('/api/market/economy/leagues')).json().error
          .code,
      ).toBe('ECONOMY_NOT_CONFIGURED');
    } finally {
      await unconfigured.close();
    }
    for (const [response, expectedCode, expectedStatus] of [
      [
        new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
        'PROVIDER_RATE_LIMITED',
        429,
      ],
      [
        new Response(JSON.stringify(overview), {
          headers: { 'Cache-Control': 'no-store' },
        }),
        'ECONOMY_ARCHIVE_DISALLOWED',
        400,
      ],
    ] as const) {
      const storage = repository();
      const client = new NinjaEconomyClient({
        userAgent: 'Worksmith tests (contact: tests@example.com)',
        fetch: async () => response,
      });
      const api = apiFor({ client, repository: storage });
      try {
        const result = await api.inject({
          method: 'POST',
          url: '/api/market/economy/collect',
          payload: { league: 'Example', category: 'BaseType' },
        });
        expect(result.statusCode).toBe(expectedStatus);
        expect(result.json().error.code).toBe(expectedCode);
        if (expectedCode === 'PROVIDER_RATE_LIMITED')
          expect(result.headers['retry-after']).toBeTruthy();
        expect(await storage.list()).toHaveLength(0);
      } finally {
        await api.close();
      }
    }
  });

  it('bounds detail previews while retaining all received normalized rows', async () => {
    const body = {
      lines: Array.from({ length: 201 }, (_, id) => ({
        id,
        name: `Base ${id}`,
        detailsId: `base-${id}`,
        chaosValue: 1,
      })),
    };
    const storage = repository();
    const api = apiFor({
      repository: storage,
      client: new NinjaEconomyClient({
        userAgent: 'Worksmith tests (contact: tests@example.com)',
        fetch: async () => new Response(JSON.stringify(body)),
      }),
    });
    try {
      const result = await api.inject({
        method: 'POST',
        url: '/api/market/economy/collect',
        payload: { league: 'Example', category: 'BaseType' },
      });
      expect(result.statusCode).toBe(200);
      const snapshot = result.json().data.snapshot;
      expect(snapshot.lineCount).toBe(201);
      expect(snapshot.lines).toHaveLength(200);
      expect(snapshot.truncated).toBe(true);
      expect((await storage.find(snapshot.id))?.lines).toHaveLength(201);
    } finally {
      await api.close();
    }
  });
});
