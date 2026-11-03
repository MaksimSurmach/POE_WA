import { createInMemoryRepositories, DomainError } from '@poe-worksmith/domain';
import { describe, expect, it, vi } from 'vitest';

import { PoeTradeClient, type PoeTradeFetch } from './poeTrade.js';
import { GggRateLimitController } from '../rateLimitController.js';

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
        fee:
          index === 0 ? { feeType: 'listed' } : { amount: 1, currency: 'gold' },
        indexed: `2026-07-19T23:${String(59 - index).padStart(2, '0')}:00.000Z`,
        price: { amount: index + 10, currency: 'divine' },
      },
    }))
    .reverse(),
};

describe('PoE Trade Merchant client', () => {
  it('keeps exchange and item-search policy mappings and circuits independent', async () => {
    const repository = createInMemoryRepositories().rateLimits;
    let now = new Date('2026-07-20T00:00:00Z');
    const circuits = {
      beforeRequest: vi.fn().mockResolvedValue({}),
      recordFailure: vi.fn().mockResolvedValue({}),
      recordSuccess: vi.fn().mockResolvedValue({}),
    };
    const client = new PoeTradeClient({
      userAgent: 'fixture',
      circuits,
      rateLimits: new GggRateLimitController({
        repository,
        clock: () => now,
        sleep: async (ms) => {
          now = new Date(now.getTime() + ms);
        },
      }),
      fetch: async (url) =>
        Response.json(
          { id: 'empty', result: [], total: 0 },
          {
            headers: {
              'X-Rate-Limit-Policy': String(url).includes('/exchange/')
                ? 'trade-exchange-request-limit'
                : 'trade-search-request-limit',
              'X-Rate-Limit-Rules': 'client',
              'X-Rate-Limit-Client': '10:1:1',
              'X-Rate-Limit-Client-State': '0:1:0',
            },
          },
        ),
    });
    const exchange = {
      league: 'Fixture',
      query: { exchange: { have: ['chaos'], want: ['divine'] } },
      schemaVersion: 1 as const,
    };
    await client.search(exchange);
    await client.search({
      league: 'Fixture',
      query: { query: { type: 'Jewel' } },
      schemaVersion: 1,
    });
    await client.search(exchange);
    const states = await repository.list();
    expect(
      states.find((s) => s.policy === 'trade-exchange-request-limit')
        ?.endpoints,
    ).toEqual(['trade-exchange']);
    expect(
      states.find((s) => s.policy === 'trade-search-request-limit')?.endpoints,
    ).toEqual(['trade-search']);
    expect(circuits.beforeRequest.mock.calls).toEqual([
      ['trade-exchange'],
      ['trade-search'],
      ['trade-exchange'],
    ]);
    expect(circuits.recordSuccess.mock.calls).toEqual(
      circuits.beforeRequest.mock.calls,
    );
  });

  it('aborts rate-limit waits and rejects subsequent requests during shutdown', async () => {
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetcher = vi.fn<typeof fetch>();
    const client = new PoeTradeClient({
      userAgent: 'test',
      fetch: fetcher,
      rateLimits: {
        waitForPermit: async (_endpoint, signal) => {
          entered();
          return new Promise((_resolve, reject) =>
            signal!.addEventListener('abort', () => reject(signal!.reason), {
              once: true,
            }),
          );
        },
        observeResponse: vi.fn().mockResolvedValue({}),
      },
    });
    const request = {
      league: 'Fixture League',
      query: { exchange: { have: ['chaos'], want: ['divine'] } },
      schemaVersion: 1 as const,
    };
    const result = client.search(request);
    await waiting;
    client.stop();
    await expect(result).rejects.toMatchObject({
      code: 'MARKET_COLLECTION_CANCELLED',
    });
    await expect(client.search(request)).rejects.toMatchObject({
      code: 'MARKET_COLLECTION_CANCELLED',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps exchange offer IDs unique within one listing', async () => {
    const client = new PoeTradeClient({
      baseUrl: 'https://trade.test',
      fetch: async () =>
        Response.json({
          id: 'exchange-id',
          result: {
            listing: {
              id: 'listing-id',
              listing: {
                account: { name: 'seller' },
                indexed: '2026-07-19T23:59:00+00:00',
                offers: [
                  {
                    exchange: { amount: 2, currency: 'chaos' },
                    item: { amount: 1, currency: 'alt' },
                  },
                  {
                    exchange: { amount: 3, currency: 'chaos' },
                    item: { amount: 2, currency: 'alt' },
                  },
                ],
              },
            },
          },
          total: 1,
        }),
      userAgent: 'OAuth poe-worksmith/0.0.0 (contact: test@example.com)',
    });

    const result = await client.search({
      league: 'Settlers',
      query: { exchange: { have: ['chaos'], want: ['alt'] } },
      schemaVersion: 1,
    });
    expect(result.listings.map(({ id }) => id)).toEqual([
      'listing-id:0',
      'listing-id:1',
    ]);
  });

  it('forces Merchant search and returns the ordered top ten without seller dedupe', async () => {
    const calls: { init: RequestInit | undefined; url: string }[] = [];
    const rateLimits = {
      observeResponse: vi.fn().mockResolvedValue({}),
      waitForPermit: vi.fn().mockResolvedValue({}),
    };
    const circuits = {
      beforeRequest: vi.fn().mockResolvedValue({}),
      recordFailure: vi.fn().mockResolvedValue({}),
      recordSuccess: vi.fn().mockResolvedValue({}),
    };
    const fetch: PoeTradeFetch = async (input, init) => {
      calls.push({ init, url: String(input) });
      return Response.json(
        calls.length === 1 ? mockSearchResponse : mockFetchResponse,
      );
    };
    const client = new PoeTradeClient({
      baseUrl: 'https://trade.test',
      circuits,
      clock: () => new Date('2026-07-20T00:00:00.000Z'),
      fetch,
      rateLimits,
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
    expect(circuits.beforeRequest.mock.calls).toEqual([
      ['trade-search'],
      ['trade-fetch'],
    ]);
    expect(circuits.recordSuccess.mock.calls).toEqual([
      ['trade-search'],
      ['trade-fetch'],
    ]);
    expect(circuits.recordFailure).not.toHaveBeenCalled();
    expect(
      rateLimits.waitForPermit.mock.calls.map(([endpoint]) => [endpoint]),
    ).toEqual([['trade-search'], ['trade-fetch']]);
    expect(
      rateLimits.observeResponse.mock.calls.map(([endpoint]) => endpoint),
    ).toEqual(['trade-search', 'trade-fetch']);
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
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
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
    expect(result.listings.some(({ fee }) => fee === null)).toBe(true);
    expect(result.listings[0]).toMatchObject({
      ageSeconds: 60,
      fee: null,
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

  it('routes currency queries through exchange with the same safe search policy', async () => {
    const calls: { init: RequestInit | undefined; url: string }[] = [];
    const client = new PoeTradeClient({
      baseUrl: 'https://trade.test',
      fetch: async (input, init) => {
        calls.push({ init, url: String(input) });
        return Response.json({ id: 'exchange-id', result: [], total: 0 });
      },
      userAgent: 'OAuth poe-worksmith/0.0.0 (contact: test@example.com)',
    });
    const query = {
      exchange: { have: ['divine'], want: ['chaos'] },
    } as const;

    await client.search({ league: 'Settlers', query, schemaVersion: 1 });

    expect(calls[0]?.url).toBe(
      'https://trade.test/api/trade/exchange/Settlers',
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      exchange: {
        have: ['divine'],
        status: { option: 'online' },
        want: ['chaos'],
      },
    });
    expect(query).toEqual({
      exchange: { have: ['divine'], want: ['chaos'] },
    });
  });

  it('fills the exchange listing sample from offers beyond the first ten rows', async () => {
    const result = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [
        `offer-${index}`,
        {
          id: `offer-${index}`,
          listing: {
            account: { name: `seller-${index}` },
            indexed: '2026-07-19T23:59:00+00:00',
            offers:
              index === 10
                ? [
                    {
                      exchange: { amount: 1, currency: 'chaos' },
                      item: { amount: 1, currency: 'alt' },
                    },
                  ]
                : [],
          },
        },
      ]),
    );
    const client = new PoeTradeClient({
      baseUrl: 'https://trade.test',
      fetch: async () =>
        Response.json({ id: 'exchange-id', result, total: 11 }),
      userAgent: 'OAuth poe-worksmith/0.0.0 (contact: test@example.com)',
    });

    await expect(
      client.search({
        league: 'Settlers',
        query: { exchange: { have: ['chaos'], want: ['alt'] } },
        schemaVersion: 1,
      }),
    ).resolves.toMatchObject({
      listings: [
        { id: 'offer-10:0', price: { amount: '1', currency: 'chaos' } },
      ],
      totalResults: 11,
    });
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

  it('classifies malformed provider schemas separately at runtime', async () => {
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
    ).rejects.toMatchObject({ code: 'PROVIDER_SCHEMA_CHANGED' });
  });

  it('does not call the provider while its endpoint circuit is open', async () => {
    const fetch = vi.fn<PoeTradeFetch>();
    const circuits = {
      beforeRequest: vi
        .fn()
        .mockRejectedValue(new DomainError('PROVIDER_CIRCUIT_OPEN')),
      recordFailure: vi.fn().mockResolvedValue({}),
      recordSuccess: vi.fn().mockResolvedValue({}),
    };
    const client = new PoeTradeClient({
      baseUrl: 'https://trade.test',
      circuits,
      fetch,
      userAgent: 'OAuth poe-worksmith/0.0.0 (contact: test@example.com)',
    });

    await expect(
      client.search({
        league: 'Settlers',
        query: { query: { type: 'Jewel' } },
        schemaVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CIRCUIT_OPEN' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('classifies transport timeouts as retryable provider failures', async () => {
    const circuits = {
      beforeRequest: vi.fn().mockResolvedValue({}),
      recordFailure: vi.fn().mockResolvedValue({}),
      recordSuccess: vi.fn().mockResolvedValue({}),
    };
    const timeout = new DOMException('request timed out', 'TimeoutError');
    const client = new PoeTradeClient({
      baseUrl: 'https://trade.test',
      circuits,
      fetch: async () => {
        throw timeout;
      },
      userAgent: 'OAuth poe-worksmith/0.0.0 (contact: test@example.com)',
    });

    await expect(
      client.search({
        league: 'Settlers',
        query: { query: { type: 'Jewel' } },
        schemaVersion: 1,
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      disposition: 'retryable',
    });
    expect(circuits.recordFailure).toHaveBeenCalledWith(
      'trade-search',
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
    );
  });
});
