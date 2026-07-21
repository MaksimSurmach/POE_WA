import { readFile } from 'node:fs/promises';

import { createInMemoryRepositories, DomainError } from '@poe-worksmith/domain';
import { describe, expect, it, vi } from 'vitest';

import { GggRateLimitController } from '../rateLimitController.js';
import { ProviderContractError } from './providerContractError.js';
import { PoeTradeClient, type PoeTradeFetch } from './poeTrade.js';

const fixture = async (name: string) =>
  JSON.parse(
    await readFile(
      new URL(`./fixtures/poeTrade/${name}`, import.meta.url),
      'utf8',
    ),
  ) as unknown;

const itemQuery = { query: { type: 'Fixture Item' } } as const;
const exchangeQuery = {
  exchange: { have: ['divine'], want: ['chaos'] },
} as const;
const request = (query: typeof itemQuery | typeof exchangeQuery) => ({
  league: 'Fixture League',
  query,
  schemaVersion: 1 as const,
});
type Warning = (context: unknown, message: string) => void;

describe('PoE Trade provider contracts', () => {
  it('parses checked-in item search and fetch fixtures through the client', async () => {
    const [search, fetched] = await Promise.all([
      fixture('search.success.json'),
      fixture('fetch.success.json'),
    ]);
    const client = clientFrom([search, fetched]);

    const result = await client.search(request(itemQuery));

    expect(result.listings).toHaveLength(10);
    expect(result.listings.map(({ id }) => id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `fixture-item-${index + 1}`),
    );
    expect(
      result.listings.filter(({ account }) => account === 'fixture-seller-1'),
    ).toHaveLength(2);
  });

  it('parses checked-in empty and exchange fixtures through their endpoint policies', async () => {
    const [empty, exchange] = await Promise.all([
      fixture('search.empty.json'),
      fixture('exchange.success.json'),
    ]);
    const calls: string[] = [];
    const client = clientFrom([empty, exchange], calls);

    await expect(client.search(request(itemQuery))).resolves.toMatchObject({
      listings: [],
    });
    await expect(client.search(request(exchangeQuery))).resolves.toMatchObject({
      listings: [],
    });
    expect(calls).toEqual([
      'https://trade.fixture/api/trade/search/Fixture%20League',
      'https://trade.fixture/api/trade/exchange/Fixture%20League',
    ]);
  });

  it.each([
    ['search.malformed.json', [], 'trade-search', 'result.0'],
    [
      'fetch.malformed.json',
      ['search.success.json'],
      'trade-fetch',
      'result.0.listing.price.currency',
    ],
  ] as const)(
    'reports safe schema paths from %s',
    async (malformedName, prefixNames, endpoint, issuePath) => {
      const responses = await Promise.all([
        ...prefixNames.map((name) => fixture(name)),
        fixture(malformedName),
      ]);
      const warn = vi.fn<Warning>();
      const client = clientFrom(responses, [], warn);

      const error = await client
        .search(request(itemQuery))
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(ProviderContractError);
      expect(error).toMatchObject({
        code: 'PROVIDER_SCHEMA_CHANGED',
        endpoint,
        issuePaths: [issuePath],
        provider: 'poe-trade',
      });
      expect(warn).toHaveBeenCalledWith(
        {
          endpoint,
          errorCode: 'PROVIDER_SCHEMA_CHANGED',
          issuePaths: [issuePath],
          provider: 'poe-trade',
        },
        'provider schema mismatch',
      );
    },
  );

  it('keeps invalid JSON separate from schema drift', async () => {
    const client = new PoeTradeClient({
      baseUrl: 'https://trade.fixture',
      fetch: async () =>
        new Response('not-json', {
          headers: { 'content-type': 'application/json' },
        }),
      userAgent: 'fixture-agent',
    });

    await expect(client.search(request(itemQuery))).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE_INVALID',
    } satisfies Partial<DomainError>);
  });

  it('keeps 429 rate-limit behavior and updates the gate from its fixture', async () => {
    const rateLimit = (await fixture('rate-limit-429.json')) as {
      headers: Record<string, string>;
      status: number;
    };
    const repositories = createInMemoryRepositories();
    const rateLimits = new GggRateLimitController({
      clock: () => new Date('2026-07-20T00:00:00.000Z'),
      repository: repositories.rateLimits,
    });
    const client = new PoeTradeClient({
      baseUrl: 'https://trade.fixture',
      fetch: async () =>
        new Response(null, {
          headers: rateLimit.headers,
          status: rateLimit.status,
        }),
      rateLimits,
      userAgent: 'fixture-agent',
    });

    await expect(client.search(request(itemQuery))).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
    });
    await expect(repositories.rateLimits.list()).resolves.toMatchObject([
      {
        endpoints: ['trade-search'],
        lastStatus: 429,
        policy: 'fixture-trade-policy',
      },
    ]);
  });
});

function clientFrom(
  responses: readonly unknown[],
  calls: string[] = [],
  warn?: Warning,
) {
  let index = 0;
  const fetch: PoeTradeFetch = async (input) => {
    calls.push(String(input));
    return Response.json(responses[index++]);
  };
  return new PoeTradeClient({
    baseUrl: 'https://trade.fixture',
    fetch,
    ...(warn
      ? { logger: { warn: (context, message) => warn(context, message) } }
      : {}),
    userAgent: 'fixture-agent',
  });
}
