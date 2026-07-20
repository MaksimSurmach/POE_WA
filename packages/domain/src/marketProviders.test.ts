import { describe, expect, it } from 'vitest';

import {
  canonicalizeMarketQuery,
  hashMarketQuery,
  type CurrencyRateProvider,
  type MarketSearchProvider,
  type MaterialPriceProvider,
} from './marketProviders.js';

const queryA = {
  sort: { price: 'asc' },
  query: {
    stats: [
      {
        type: 'and',
        filters: [
          { value: { min: 3 }, id: 'explicit.stat_b' },
          { id: 'explicit.stat_a', disabled: false },
        ],
      },
    ],
    filters: {},
    type: 'Large Cluster Jewel',
  },
} as const;

const queryB = {
  query: {
    type: 'Large Cluster Jewel',
    stats: [
      {
        filters: [
          { id: 'explicit.stat_a' },
          { id: 'explicit.stat_b', value: { min: 3 } },
        ],
        type: 'and',
      },
    ],
  },
  sort: { price: 'asc' },
} as const;

describe('canonical market query hashing', () => {
  it('normalizes object keys, filter order, empty containers, and defaults', async () => {
    expect(canonicalizeMarketQuery(queryA)).toEqual(
      canonicalizeMarketQuery(queryB),
    );
    const hash = await hashMarketQuery({
      league: 'Settlers',
      provider: 'poe-trade',
      query: queryA,
      schemaVersion: 1,
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(
      await hashMarketQuery({
        league: 'Settlers',
        provider: 'poe-trade',
        query: queryB,
        schemaVersion: 1,
      }),
    );
  });

  it.each([
    { league: 'Standard' },
    { provider: 'static-fallback' },
    { schemaVersion: 2 },
  ])(
    'changes the hash when identity changes: $league$provider$schemaVersion',
    async (override) => {
      const base = {
        league: 'Settlers',
        provider: 'poe-trade',
        query: queryA,
        schemaVersion: 1,
      };

      expect(await hashMarketQuery({ ...base, ...override })).not.toBe(
        await hashMarketQuery(base),
      );
    },
  );

  it('does not include recipe identity and rejects non-JSON input', async () => {
    const base = {
      league: 'Settlers',
      provider: 'poe-trade',
      query: queryA,
      schemaVersion: 1,
    };
    const recipeA = { ...base, recipeId: 'recipe-a' };
    const recipeB = { ...base, recipeId: 'recipe-b' };
    expect(await hashMarketQuery(recipeA)).toBe(await hashMarketQuery(recipeB));
    await expect(
      hashMarketQuery({
        ...base,
        query: { invalid: Number.NaN },
      }),
    ).rejects.toThrow('finite numbers');
  });
});

describe('market provider contracts', () => {
  it('supports HTTP-free fake implementations', async () => {
    const fetchedAt = new Date('2026-07-20T00:00:00.000Z');
    const market: MarketSearchProvider = {
      id: 'fake-market',
      async search(request) {
        return {
          fetchedAt,
          listings: [],
          provider: this.id,
          totalResults: request.query.type === 'Jewel' ? 1 : 0,
        };
      },
    };
    const materials: MaterialPriceProvider = {
      id: 'fake-materials',
      async getPrice(request) {
        return {
          chaosAmount: '150.25',
          fetchedAt,
          materialKey: request.materialKey,
          original: { amount: '1', currency: 'divine' },
          provider: this.id,
        };
      },
    };
    const currencies: CurrencyRateProvider = {
      id: 'fake-rates',
      async getRate(request) {
        return {
          fetchedAt,
          fromCurrency: request.fromCurrency,
          provider: this.id,
          rate: '150.25',
          toCurrency: request.toCurrency,
        };
      },
    };

    await expect(
      market.search({
        league: 'Settlers',
        query: { type: 'Jewel' },
        schemaVersion: 1,
      }),
    ).resolves.toMatchObject({ provider: 'fake-market', totalResults: 1 });
    await expect(
      materials.getPrice({ league: 'Settlers', materialKey: 'divine-orb' }),
    ).resolves.toMatchObject({
      materialKey: 'divine-orb',
      chaosAmount: '150.25',
    });
    await expect(
      currencies.getRate({
        fromCurrency: 'divine',
        league: 'Settlers',
        toCurrency: 'chaos',
      }),
    ).resolves.toMatchObject({ fromCurrency: 'divine', rate: '150.25' });
  });
});
