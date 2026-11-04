import {
  apiErrorEnvelopeSchema,
  recipeTrendResponseSchema,
  trendOverviewResponseSchema,
} from '@poe-worksmith/contracts';
import type { PoeLeague, Recipe } from '@poe-worksmith/domain';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { buildApi } from './api.js';
import {
  createMarketTrendsReader,
  toTrendSummary,
  type MarketTrendsOptions,
} from './marketTrendsApi.js';
import type {
  PriceHistoryBucket,
  PriceHistorySummary,
} from './repositories/priceHistoryRepository.js';

const now = new Date('2026-11-03T12:30:00.000Z');
const league = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Fixture League',
} as PoeLeague;
const recipe = {
  active: true,
  category: 'jewel',
  contentHash: 'hash',
  id: 'fixture-recipe',
  title: 'Fixture Recipe',
} as Recipe;

function summary(window: PriceHistorySummary['window']): PriceHistorySummary {
  return {
    latest: {
      currency: 'chaos',
      ask: window?.close ?? '10',
      observedAt: window?.lastObservedAt ?? new Date('2026-10-01T00:00:00Z'),
      comparableSellers: 1,
      coverage: 'complete',
      craftCost: null,
      craftCostObservedAt: null,
    },
    window,
    excludedCurrencies: [],
  };
}

function api(options: {
  summaries?: Map<string, PriceHistorySummary>;
  buckets?: PriceHistoryBucket[];
  league?: PoeLeague | null;
  recipes?: Recipe[];
}) {
  const calls: unknown[] = [];
  const history: MarketTrendsOptions['history'] = {
    async readSummaries(input) {
      calls.push(input);
      return options.summaries ?? new Map();
    },
    async readBuckets(input) {
      calls.push(input);
      return options.buckets ?? [];
    },
  };
  const recipes = options.recipes ?? [recipe];
  const reader = createMarketTrendsReader({
    history,
    recipes: {
      findById: async (id) => recipes.find((r) => r.id === id) ?? null,
      listActive: async () => recipes.filter((r) => r.active),
    },
    findCurrentLeague: async () =>
      options.league === undefined ? league : options.league,
    clock: () => now,
  });
  return {
    calls,
    server: buildApi(
      pino({ level: 'silent' }),
      async () => undefined,
      async () => ({ active: null, published: null }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { marketTrends: reader },
    ),
  };
}

describe('market trend API', () => {
  it.each([
    '/api/trends?range=2d',
    '/api/trends?range=24h&range=7d',
    '/api/trends/fixture-recipe?range=all',
    '/api/trends/bad%20id',
  ])('rejects invalid input %s', async (url) => {
    const { server } = api({});
    const response = await server.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(apiErrorEnvelopeSchema.parse(response.json()).error.code).toBe(
      'MARKET_QUERY_INVALID',
    );
    await server.close();
  });

  it.each([
    ['unknown', [recipe]],
    ['inactive', [{ ...recipe, id: 'unknown', active: false } as Recipe]],
  ])('returns 404 for an %s recipe', async (_label, recipes) => {
    const { server } = api({ recipes });
    const response = await server.inject({
      method: 'GET',
      url: '/api/trends/unknown?range=7d',
    });
    expect(response.statusCode).toBe(404);
    expect(apiErrorEnvelopeSchema.parse(response.json()).error.code).toBe(
      'PERSISTENCE_NOT_FOUND',
    );
    await server.close();
  });

  it('reports unavailable without a current league and empty without history', async () => {
    const unavailable = api({ league: null });
    const overview = trendOverviewResponseSchema.parse(
      (await unavailable.server.inject({ url: '/api/trends' })).json(),
    );
    expect(overview.data).toMatchObject({
      state: 'unavailable',
      range: '7d',
      entries: [],
      priceBasis: 'asking',
      salesVolume: 'unknown',
    });
    const detail = recipeTrendResponseSchema.parse(
      (
        await unavailable.server.inject({
          url: '/api/trends/fixture-recipe?range=24h',
        })
      ).json(),
    );
    expect(detail.data).toMatchObject({ state: 'unavailable', buckets: [] });
    expect(unavailable.calls).toEqual([]);

    const empty = api({});
    const emptyDetail = recipeTrendResponseSchema.parse(
      (await empty.server.inject({ url: '/api/trends/fixture-recipe' })).json(),
    );
    expect(emptyDetail.data).toMatchObject({
      state: 'empty',
      summary: null,
      buckets: [],
      bucketSeconds: 4 * 3600,
      windowStart: '2026-10-27T12:00:00.000Z',
      windowEnd: now.toISOString(),
    });
    await Promise.all([unavailable.server.close(), empty.server.close()]);
  });

  it('serves one series with UTC buckets and the latest currency', async () => {
    const at = (iso: string) => new Date(iso);
    const buckets: PriceHistoryBucket[] = [
      {
        start: at('2026-11-01T00:00:00Z'),
        firstObservedAt: at('2026-11-01T01:00:00Z'),
        lastObservedAt: at('2026-11-01T05:00:00Z'),
        open: '100.00000000',
        high: '120.00000000',
        low: '90.00000000',
        close: '110.00000000',
        observations: 3,
        craftCost: '40.00000000',
        craftCostObservedAt: at('2026-11-01T05:00:00Z'),
        minComparableSellers: 1,
        lastComparableSellers: 4,
      },
    ];
    const { server, calls } = api({
      buckets,
      summaries: new Map([
        [
          recipe.id,
          summary({
            currency: 'chaos',
            firstObservedAt: at('2026-11-01T01:00:00Z'),
            lastObservedAt: at('2026-11-01T05:00:00Z'),
            open: '100',
            close: '110',
            observations: 3,
          }),
        ],
      ]),
    });
    const response = recipeTrendResponseSchema.parse(
      (
        await server.inject({ url: '/api/trends/fixture-recipe?range=30d' })
      ).json(),
    );
    expect(response.data.state).toBe('available');
    expect(response.data.buckets[0]).toMatchObject({
      start: '2026-11-01T00:00:00.000Z',
      open: 100,
      close: 110,
      craftCost: 40,
      minComparableSellers: 1,
    });
    expect(response.data.summary?.change).toEqual({
      from: 100,
      fromObservedAt: '2026-11-01T01:00:00.000Z',
      to: 110,
      toObservedAt: '2026-11-01T05:00:00.000Z',
      absolute: 10,
      percent: 10,
    });
    expect(calls.at(-1)).toMatchObject({
      currency: 'chaos',
      range: '30d',
      recipeId: recipe.id,
      leagueId: league.id,
    });
    await server.close();
  });

  it('lists every active recipe in the overview, including ones without history', async () => {
    const other = { ...recipe, id: 'a-recipe', title: 'A Recipe' } as Recipe;
    const { server } = api({
      recipes: [recipe, other],
      summaries: new Map([[recipe.id, summary(null)]]),
    });
    const overview = trendOverviewResponseSchema.parse(
      (await server.inject({ url: '/api/trends?range=1y' })).json(),
    );
    expect(overview.data.state).toBe('available');
    expect(overview.data.entries.map((e) => [e.recipeId, !!e.summary])).toEqual(
      [
        ['a-recipe', false],
        ['fixture-recipe', true],
      ],
    );
    // An old latest observation outside the window has no window change.
    expect(overview.data.entries[1]?.summary).toMatchObject({
      windowObservations: 0,
      change: null,
      latestObservedAt: '2026-10-01T00:00:00.000Z',
    });
    await server.close();
  });
});

describe('trend summaries', () => {
  const t = (h: number) => new Date(Date.UTC(2026, 10, 1, h));
  it('never reports change for a single observation', () => {
    expect(
      toTrendSummary(
        summary({
          currency: 'chaos',
          firstObservedAt: t(1),
          lastObservedAt: t(1),
          open: '10',
          close: '10',
          observations: 1,
        }),
      ).change,
    ).toBeNull();
  });

  it('reports a flat series as zero change and a zero opening ask without percent', () => {
    expect(
      toTrendSummary(
        summary({
          currency: 'chaos',
          firstObservedAt: t(1),
          lastObservedAt: t(3),
          open: '10',
          close: '10',
          observations: 2,
        }),
      ).change,
    ).toMatchObject({ absolute: 0, percent: 0 });
    expect(
      toTrendSummary(
        summary({
          currency: 'chaos',
          firstObservedAt: t(1),
          lastObservedAt: t(3),
          open: '0',
          close: '5',
          observations: 2,
        }),
      ).change,
    ).toMatchObject({ absolute: 5, percent: null });
  });
});
