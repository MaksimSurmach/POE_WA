import { createInMemoryRepositories } from '@poe-worksmith/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuredTradeCapture } from './collectorTrade.js';
import type { StoredMarketEconomySnapshot } from './marketEconomy.js';
import { GggRateLimitController } from './rateLimitController.js';

const at = new Date('2026-11-01T12:00:00.000Z');
const exchangeId = 'fcafcbbb-601d-491f-8b01-f0dd151a4b24';
const environment = {
  MARKET_COLLECTION_SOURCE: 'trade-compatible',
  POE_TRADE_ACCESS: 'owner_permitted',
  POE_TRADE_USER_AGENT: 'Worksmith test collector',
};

function target(mixed = false) {
  return {
    payload: {
      provider: 'poe-trade',
      schemaVersion: 1,
      recipeIds: ['fixture'],
      query: {
        handbookTarget: JSON.stringify({
          name: 'Collector test',
          game: 'poe1',
          realm: 'pc',
          league: 'Demo',
          patch: '3.28',
          slot: 'crafted-item',
          baseTypes: ['Stygian Vise'],
          builds: [],
          requiredMods: [],
          sources: [],
          tradeSearch: {
            version: 1,
            scope: 'strict',
            status: 'available',
            currency: 'chaos',
            rarity: 'rare',
            groups: [],
            includeOtherCurrencies: mixed,
            ...(mixed ? { exchangeSnapshotId: exchangeId } : {}),
          },
        }),
      },
    },
  };
}

function listings(count: number, currency = 'chaos') {
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${i + 1}`,
    listing: {
      indexed: at.toISOString(),
      account: { name: `seller-${i}` },
      price: { amount: i + 1, currency },
    },
    item: {
      baseType: 'Stygian Vise',
      ilvl: 84,
      explicitMods: ['+90 to maximum Life'],
      note: `~price ${i + 1} ${currency}`,
    },
  }));
}

function setup(
  data: ReturnType<typeof listings>,
  options: {
    omit?: string;
    malformed?: string;
    replacement?: { requested: string; returned: string };
    inexact?: boolean;
    moveBeforeRecheck?: boolean;
    exchange?: StoredMarketEconomySnapshot;
    status?: number;
  } = {},
) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  const requests = { search: 0, ranged: 0, detail: 0 };
  const index = new Map(data.map((row) => [row.id, row]));
  const fetch = vi.fn(async (input: URL, init?: RequestInit) => {
    if (input.pathname.includes('/search/')) {
      requests.search++;
      if (options.status)
        return new Response(null, {
          status: options.status,
          headers: { 'Retry-After': '120' },
        });
      const { min, max } = JSON.parse(String(init?.body)).query.filters
        .trade_filters.filters.price;
      if (min !== undefined || max !== undefined) requests.ranged++;
      const result = data.filter(
        ({ listing: { price } }) =>
          price.amount >= (min ?? 0) && price.amount <= (max ?? Infinity),
      );
      if (
        options.moveBeforeRecheck &&
        requests.ranged &&
        min === undefined &&
        max === undefined
      ) {
        const first = result.shift();
        if (first) result.push(first);
      }
      return Response.json({
        id: `q-${requests.search}`,
        result: result.slice(0, 100).map(({ id }) => id),
        total: result.length,
        inexact: options.inexact ?? false,
      });
    }
    requests.detail++;
    const ids = input.pathname
      .slice(input.pathname.lastIndexOf('/') + 1)
      .split(',');
    return Response.json(
      {
        result: ids.map((id) => {
          if (id === options.omit) return null;
          if (id === options.malformed) return { id, item: {}, listing: {} };
          return index.get(
            id === options.replacement?.requested
              ? options.replacement.returned
              : id,
          );
        }),
      },
      {
        headers:
          options.malformed && ids.includes(options.malformed)
            ? { 'X-Rate-Limit-Policy': 'collector-malformed-details' }
            : {},
      },
    );
  });
  vi.stubGlobal('fetch', fetch);
  const repository = createInMemoryRepositories().rateLimits;
  let now = at;
  const rateLimits = new GggRateLimitController({
    repository,
    clock: () => now,
    sleep: async (ms) => {
      now = new Date(now.getTime() + ms);
    },
  });
  const find = vi.fn(async () => options.exchange ?? null);
  const economy = { latest: async () => null, find };
  return { rateLimits, economy, requests, find, repository, now: () => now };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('collector Trade captures', () => {
  it('captures every returned ID, including beyond the legacy 20, from fresh requests', async () => {
    const { rateLimits, economy, requests } = setup(listings(24));
    const run = configuredTradeCapture(rateLimits, economy, environment);
    const signal = new AbortController().signal;
    for (let i = 0; i < 2; i++)
      expect(await run(target(), signal)).toMatchObject({
        status: 'success',
        capture: { complete: true, fetched: 24, reportedTotal: 24 },
      });
    expect(requests).toEqual({ search: 2, ranged: 0, detail: 6 });
  });

  it('proves coverage across overlapping inclusive price slices', async () => {
    const { rateLimits, economy, requests } = setup(listings(180));
    const run = configuredTradeCapture(rateLimits, economy, environment);
    const result = await run(target(), new AbortController().signal);
    expect(result).toMatchObject({
      status: 'success',
      capture: { complete: true, fetched: 180, reportedTotal: 180 },
    });
    expect(requests.ranged).toBeGreaterThanOrEqual(2);
    expect(requests.ranged).toBeLessThanOrEqual(5);
    expect(requests.search).toBe(requests.ranged + 2);
  });

  it('keeps sliced coverage partial when the fresh root sample moves with the same total', async () => {
    const { rateLimits, economy } = setup(listings(180), {
      moveBeforeRecheck: true,
    });
    const run = configuredTradeCapture(rateLimits, economy, environment);
    expect(await run(target(), new AbortController().signal)).toMatchObject({
      status: 'success',
      capture: {
        complete: false,
        fetched: 180,
        reportedTotal: 180,
        partialReason: 'SEARCH_CHANGED_DURING_CAPTURE',
      },
    });
  });

  it('retains valid details and observes headers from a batch with a malformed row', async () => {
    const { rateLimits, economy, repository } = setup(listings(24), {
      malformed: 'id-21',
    });
    const run = configuredTradeCapture(rateLimits, economy, environment);
    const result = await run(target(), new AbortController().signal);
    expect(result).toMatchObject({
      status: 'success',
      capture: {
        complete: false,
        fetched: 23,
        partialReason: 'DETAILS_INCOMPLETE',
        listings: expect.arrayContaining([
          expect.objectContaining({ itemId: 'id-24' }),
        ]),
      },
    });
    expect(await repository.list()).toContainEqual(
      expect.objectContaining({
        policy: 'collector-malformed-details',
        lastStatus: 200,
      }),
    );
  });

  it.each([
    ['a missing detail', { omit: 'id-21' }, 23],
    [
      'an unexpected ID',
      { replacement: { requested: 'id-21', returned: 'id-2' } },
      23,
    ],
    ['an inexact total', { inexact: true }, 24],
  ] as const)('keeps %s partial', async (_label, options, fetched) => {
    const { rateLimits, economy } = setup(listings(24), options);
    const run = configuredTradeCapture(rateLimits, economy, environment);
    expect(await run(target(), new AbortController().signal)).toMatchObject({
      status: 'success',
      capture: {
        complete: false,
        fetched,
        partialReason: expect.any(String),
      },
    });
  });

  it.each([false, true])(
    'caps bounded requests and retains evidence when bounds cannot prove coverage (mixed=%s)',
    async (mixed) => {
      const { rateLimits, economy, requests } = setup(listings(601));
      const run = configuredTradeCapture(rateLimits, economy, environment);
      expect(
        await run(target(mixed), new AbortController().signal),
      ).toMatchObject({
        status: 'success',
        capture: {
          complete: false,
          reportedTotal: 601,
          fetched: mixed ? 100 : 298,
          partialReason: mixed
            ? 'MIXED_CURRENCY_SLICE_UNPROVEN'
            : 'PRICE_SLICE_LIMIT',
        },
      });
      expect(requests.ranged).toBe(mixed ? 0 : 5);
      expect(requests.search).toBe(requests.ranged + 1);
    },
  );

  it('preserves original fractional asks with one pinned exchange snapshot', async () => {
    const exchange: StoredMarketEconomySnapshot = {
      id: exchangeId,
      schemaVersion: 1,
      kind: 'economy-overview',
      source: 'poe.ninja',
      game: 'poe1',
      league: 'Demo',
      category: 'Currency',
      endpoint: 'https://poe.ninja/demo',
      payloadHash: 'a'.repeat(64),
      capturedAt: at.toISOString(),
      sourceUpdatedAt: null,
      priceBasis: 'currency-exchange',
      raw: {},
      lines: [
        {
          id: 'divine',
          name: 'Divine Orb',
          detailsId: 'divine-orb',
          baseType: null,
          price: { amount: 200, currency: 'chaos' },
          listingCount: null,
          observationCount: 10,
          tradedVolume: null,
        },
      ],
    };
    const data = listings(24, 'divine');
    const first = data[0];
    if (!first) throw new Error('Test data is empty');
    first.listing.price.amount = 2.5;
    const { rateLimits, economy, find } = setup(data, { exchange });
    const run = configuredTradeCapture(rateLimits, economy, environment);
    const result = await run(target(true), new AbortController().signal);
    expect(result).toMatchObject({
      status: 'success',
      capture: {
        complete: true,
        fxSnapshotId: exchangeId,
        listings: expect.arrayContaining([
          expect.objectContaining({
            itemId: 'id-1',
            seller: 'seller-0',
            fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
            indexedAt: at,
            price: { amount: '2.5', currency: 'divine' },
            priceChaos: '500',
          }),
        ]),
      },
    });
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('defers an observed and retained 429 without reissuing the request', async () => {
    const { rateLimits, economy, requests, now } = setup([], { status: 429 });
    const run = configuredTradeCapture(rateLimits, economy, environment);
    const signal = new AbortController().signal;
    const first = await run(target(), signal);
    expect(first).toMatchObject({
      status: 'retry',
      reason: 'PROVIDER_RATE_LIMITED',
      retryAt: new Date(at.getTime() + 120_000),
    });
    expect(await run(target(), signal)).toEqual(first);
    expect(requests.search).toBe(1);
    expect(now()).toEqual(at);
  });

  it('preserves Retry-After from HTTP 503', async () => {
    const { rateLimits, economy, requests } = setup([], { status: 503 });
    const run = configuredTradeCapture(rateLimits, economy, environment);
    expect(await run(target(), new AbortController().signal)).toEqual({
      status: 'retry',
      reason: 'PROVIDER_UNAVAILABLE',
      retryAt: new Date(at.getTime() + 120_000),
    });
    expect(requests.search).toBe(1);
  });

  it('uses structured modifier identity and requires observed modifiers for fingerprints', async () => {
    const data = listings(3);
    const [first, second, empty] = data;
    if (!first || !second || !empty) throw new Error('Fixture rows missing');
    const modifier = (hash: string) => ({
      description: '+90 to maximum Life',
      domain: 'explicit',
      hash,
      mods: [{ tier: 'P2' }],
    });
    Object.assign(first.item, { explicitMods: [modifier('stat_1')] });
    Object.assign(second.item, { explicitMods: [modifier('stat_2')] });
    Object.assign(empty.item, { explicitMods: [], verified: true });
    const { rateLimits, economy } = setup(data);
    const result = await configuredTradeCapture(
      rateLimits,
      economy,
      environment,
    )(target(), new AbortController().signal);
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('Capture failed');
    const fingerprints = result.capture.listings.map(
      ({ fingerprint }) => fingerprint,
    );
    expect(fingerprints).toEqual([
      expect.any(String),
      expect.any(String),
      null,
    ]);
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
  });

  it('reports authentication denial after one request', async () => {
    const { rateLimits, economy, requests } = setup([], { status: 401 });
    const run = configuredTradeCapture(rateLimits, economy, environment);
    expect(await run(target(), new AbortController().signal)).toEqual({
      status: 'blocked',
      reason: 'PROVIDER_AUTH_FAILED',
    });
    expect(requests.search).toBe(1);
  });

  it('never contacts Trade without explicit owner permission', async () => {
    const { rateLimits, economy, requests } = setup([]);
    const run = configuredTradeCapture(rateLimits, economy, {});
    expect(await run(target(), new AbortController().signal)).toEqual({
      status: 'blocked',
      reason: 'MARKET_ACCESS_BLOCKED',
    });
    expect(requests.search).toBe(0);
  });
});
