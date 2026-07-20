import { DomainError } from '@poe-worksmith/domain';
import { describe, expect, it } from 'vitest';

import { PoeTradeClient, type PoeTradeFetch } from './poeTrade.js';

const resultIds = Array.from(
  { length: 12 },
  (_, index) => `result-${index + 1}`,
);
const mockSearchResponse = {
  id: 'search-id',
  result: resultIds,
  total: 42,
};
const mockFetchResponse = {
  result: resultIds
    .slice(0, 10)
    .map((id, index) => ({
      id,
      item: {
        baseType: 'Large Cluster Jewel',
        ilvl: 84,
        name: `Crafted Jewel ${index + 1}`,
      },
      listing: {
        account: { name: index < 2 ? 'same-seller' : `seller-${index}` },
        fee: { amount: 1, currency: 'gold' },
        indexed: `2026-07-19T23:${String(59 - index).padStart(2, '0')}:00.000Z`,
        price: { amount: index + 10, currency: 'divine' },
      },
    }))
    .reverse(),
};

describe('PoE Trade Merchant client', () => {
  it('forces Merchant search and returns the ordered top ten without seller dedupe', async () => {
    const calls: { init: RequestInit | undefined; url: string }[] = [];
    const fetch: PoeTradeFetch = async (input, init) => {
      calls.push({ init, url: String(input) });
      return Response.json(
        calls.length === 1 ? mockSearchResponse : mockFetchResponse,
      );
    };
    const client = new PoeTradeClient({
      baseUrl: 'https://trade.test',
      clock: () => new Date('2026-07-20T00:00:00.000Z'),
      fetch,
      userAgent: 'OAuth poe-worksmith/0.0.0 (contact: test@example.com)',
    });
    const input = {
      query: {
        query: {
          stats: [
            {
              filters: [{ id: 'explicit.stat_1', value: { min: 3 } }],
              type: 'and',
            },
          ],
          status: { option: 'offline' },
          type: 'Large Cluster Jewel',
        },
        sort: { indexed: 'desc' },
      },
      league: 'Settlers',
      schemaVersion: 1,
    } as const;

    const result = await client.search(input);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://trade.test/api/trade/search/Settlers');
    const searchBody = JSON.parse(String(calls[0]?.init?.body)) as {
      query: { stats: unknown; status: { option: string } };
      sort: { price: string };
    };
    expect(searchBody.query.status.option).toBe('securable');
    expect(searchBody.query.stats).toEqual(input.query.query.stats);
    expect(searchBody.sort).toEqual({ price: 'asc' });
    expect(input.query.query.status.option).toBe('offline');
    expect(calls[1]?.url).toContain(
      `/api/trade/fetch/${resultIds.slice(0, 10).join(',')}?query=search-id`,
    );
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get('user-agent')).toContain('poe-worksmith');
      expect(headers.has('cookie')).toBe(false);
      expect(headers.has('authorization')).toBe(false);
    }
    expect(result.totalResults).toBe(42);
    expect(result.listings).toHaveLength(10);
    expect(result.listings.map(({ id }) => id)).toEqual(resultIds.slice(0, 10));
    expect(
      result.listings.every(({ ageSeconds }) => Number.isInteger(ageSeconds)),
    ).toBe(true);
    expect(
      result.listings.filter(({ account }) => account === 'same-seller'),
    ).toHaveLength(2);
    expect(result.listings[0]).toMatchObject({
      ageSeconds: 60,
      fee: { amount: '1', currency: 'gold' },
      item: { baseType: 'Large Cluster Jewel', ilvl: 84 },
      price: { amount: '10', currency: 'divine' },
    });
  });

  it('returns an explicit empty result without a fetch request', async () => {
    let calls = 0;
    const client = new PoeTradeClient({
      baseUrl: 'https://trade.test',
      fetch: async () => {
        calls += 1;
        return Response.json({ id: 'empty', result: [], total: 0 });
      },
      userAgent: 'OAuth poe-worksmith/0.0.0 (contact: test@example.com)',
    });

    await expect(
      client.search({
        league: 'Settlers',
        query: { query: { type: 'Jewel' } },
        schemaVersion: 1,
      }),
    ).resolves.toMatchObject({ listings: [], totalResults: 0 });
    expect(calls).toBe(1);
  });

  it.each([
    [400, 'MARKET_QUERY_INVALID'],
    [401, 'PROVIDER_AUTH_FAILED'],
    [429, 'PROVIDER_RATE_LIMITED'],
    [503, 'PROVIDER_UNAVAILABLE'],
  ] as const)('maps HTTP %s to %s', async (status, code) => {
    const client = new PoeTradeClient({
      baseUrl: 'https://trade.test',
      fetch: async () => new Response(null, { status }),
      userAgent: 'OAuth poe-worksmith/0.0.0 (contact: test@example.com)',
    });

    const error = await client
      .search({
        league: 'Settlers',
        query: { query: { type: 'Jewel' } },
        schemaVersion: 1,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code });
  });

  it('rejects malformed provider responses at runtime', async () => {
    const client = new PoeTradeClient({
      baseUrl: 'https://trade.test',
      fetch: async () => Response.json({ id: 'bad', result: [1], total: 1 }),
      userAgent: 'OAuth poe-worksmith/0.0.0 (contact: test@example.com)',
    });

    await expect(
      client.search({
        league: 'Settlers',
        query: { query: { type: 'Jewel' } },
        schemaVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
  });
});
