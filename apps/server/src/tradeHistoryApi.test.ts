import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { expect, it } from 'vitest';
import { buildApi } from './api.js';
import { marketListingFixture } from './marketListingFixture.js';
import {
  createImportedMarketSnapshot,
  createMarketTarget,
} from './marketResearch.js';
import type { TradeHistoryRepository } from './tradeHistoryApi.js';

function testApi(repository: TradeHistoryRepository) {
  return buildApi(
    pino({ level: 'silent' }),
    async () => {},
    async () => ({ active: null, published: null }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { marketResearch: repository },
  );
}

it('returns an archived snapshot after raw listing retention', async () => {
  const fixture = marketListingFixture();
  const target = createMarketTarget(fixture.target);
  const snapshot = {
    ...createImportedMarketSnapshot(fixture.observation(target.id), target),
    rawAvailable: false,
    listings: [],
  };
  const api = testApi({
    findSnapshot: async (id) => (id === snapshot.id ? snapshot : null),
  });
  try {
    const stored = await api.inject(
      `/api/trade-history/snapshots/${snapshot.id}`,
    );
    expect(stored.statusCode).toBe(200);
    expect(stored.json().data).toMatchObject({
      id: snapshot.id,
      rawAvailable: false,
      count: 5,
      median: 50,
      listings: [],
    });
    expect(
      (await api.inject('/api/trade-history/snapshots/invalid')).statusCode,
    ).toBe(404);
    expect(
      (await api.inject(`/api/trade-history/snapshots/${randomUUID()}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await api.inject(`/api/market/snapshots/${snapshot.id}`)).statusCode,
    ).toBe(404);
  } finally {
    await api.close();
  }
});

it('passes the selected league, target and range to the archive reader', async () => {
  const target = randomUUID();
  const api = testApi({
    findSnapshot: async () => null,
    readTradeDashboard: async (start, end, league, id) => {
      expect(end.getTime() - start.getTime()).toBe(86_400_000);
      expect(league).toBe('Allflame');
      expect(id).toBe(target);
      return { league: league ?? null, items: [], points: [] };
    },
  });
  try {
    const response = await api.inject(
      `/api/trade-history?range=24h&league=Allflame&target=${target}`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().data).toMatchObject({
      league: 'Allflame',
      range: '24h',
    });
    expect(
      (await api.inject('/api/trade-history?range=invalid')).statusCode,
    ).toBe(400);
    expect((await api.inject('/api/market/trade-dashboard')).statusCode).toBe(
      404,
    );
  } finally {
    await api.close();
  }
});
