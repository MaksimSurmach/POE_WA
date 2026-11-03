import type { CanonicalJsonValue } from '@poe-worksmith/domain';
import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { beltDemoFixture } from '../beltDemoFixture.js';
import {
  createMarketTarget,
  createImportedMarketSnapshot,
} from '../marketResearch.js';
import { comparableRecipeListings } from '../recipeMarket.js';
import { analyzeBeltSnapshot } from '../beltComparability.js';
import { generateMarketTradeQuery } from '../marketTradeQuery.js';
import {
  TradeCompatibleTransport,
  loadTradeCompatibleConfig,
  normalizeTradeCompatibleListing,
} from './tradeCompatible.js';
import { createBatchedMarketCollectionSource } from '../marketCollection.js';

const at = new Date('2026-11-01T12:00:00.000Z');
export function tradeTarget() {
  return createMarketTarget(
    {
      ...beltDemoFixture(at).target,
      tradeSearch: {
        version: 1,
        scope: 'strict',
        status: 'available',
        currency: 'chaos',
        rarity: 'rare',
        groups: [
          {
            type: 'and',
            filters: [{ id: 'explicit.stat_3299347043', key: 'life', min: 80 }],
          },
        ],
      },
    },
    at,
  );
}
// Synthetic endpoint-format fixture, based on the recorded manual life roll. Not a live API capture.
export function rawTradeListing(id = 'listing-1', life = 90) {
  return {
    id,
    listing: {
      indexed: at.toISOString(),
      price: { amount: 40, currency: 'chaos' },
      account: { name: `seller-${id}` },
    },
    item: {
      baseType: 'Stygian Vise',
      frameType: 2,
      league: 'Demo',
      ilvl: 84,
      corrupted: false,
      influences: {},
      explicitMods: [`+${life} to maximum Life`],
      implicitMods: ['Has 1 Abyssal Socket'],
      extended: {
        hashes: { explicit: [['explicit.stat_3299347043', [0]]] },
        mods: {
          explicit: [
            {
              tier: 'P2',
              magnitudes: [
                { hash: 'explicit.stat_3299347043', min: 80, max: 99 },
              ],
            },
          ],
        },
      },
    },
  };
}
const config = loadTradeCompatibleConfig({
  POE_TRADE_USER_AGENT: 'Worksmith beta test',
  POE_TRADE_SESSION_ID: 'private-session',
});

describe('Trade-compatible queries and transport', () => {
  it('enforces the exact model item level in the live request and rejects an empty range', () => {
    const target = { ...tradeTarget(), minItemLevel: 84, maxItemLevel: 84 };
    expect(
      generateMarketTradeQuery(target).request.query.filters.misc_filters
        .filters.ilvl,
    ).toEqual({ min: 84, max: 84 });
    expect(() =>
      generateMarketTradeQuery({
        ...target,
        minItemLevel: 82,
        maxItemLevel: 83,
      }),
    ).toThrow('The market query is invalid.');
  });

  it('normalizes an observed cluster enum hash with null magnitude indexes', async () => {
    const raw = JSON.parse(
      await readFile(
        new URL(
          './fixtures/tradeCompatible/fetch.cluster-modern.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const row = normalizeTradeCompatibleListing(raw.result[0], tradeTarget());
    expect(row.item.mods).toContainEqual({
      id: 'enchant.stat_3948993189|12',
      value: 1,
    });
    expect(row.item.mods).toContainEqual({
      id: 'explicit.stat_4188581520',
      value: 1,
      tier: 1,
    });
  });

  it('omits a currency restriction when comparing converted mixed-currency asks', () => {
    const target = tradeTarget();
    const request = generateMarketTradeQuery({
      ...target,
      tradeSearch: { ...target.tradeSearch!, includeOtherCurrencies: true },
    }).request;
    expect(request.query.filters.trade_filters.filters.price).toEqual({});
    expect(
      generateMarketTradeQuery(target).request.query.filters.trade_filters
        .filters.price,
    ).toEqual({ option: 'chaos' });
  });

  it('normalizes the sanitized November 1 object-mod response and preserves crafted origin', async () => {
    const raw = JSON.parse(
      await readFile(
        new URL(
          './fixtures/tradeCompatible/fetch.modern.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { result: unknown[] };
    const row = normalizeTradeCompatibleListing(raw.result[0], tradeTarget());
    expect(row.item.corrupted).toBe(false);
    expect(row.item.fractured).toBe(false);
    expect(row.item.mods).toContainEqual({
      id: 'explicit.stat_3299347043',
      value: 128,
      tier: 2,
    });
    expect(row.item.mods).toContainEqual({
      id: 'crafted.stat_387439868',
      value: 32,
    });
    expect(row.item.mods).not.toContainEqual(
      expect.objectContaining({ id: 'explicit.stat_387439868' }),
    );
    expect(row.item.mods).toContainEqual({
      id: 'pseudo.pseudo_total_elemental_resistance',
      value: 80,
    });
    expect(row.rawListing?.item).toHaveProperty('explicitMods.0.description');
  });
  it('matches count groups, enforces actual tiers and keeps missing tier evidence partial', () => {
    const target = tradeTarget();
    const search = target.tradeSearch!;
    const grouped = {
      ...target,
      tradeSearch: {
        ...search,
        groups: [
          {
            type: 'count' as const,
            min: 1,
            filters: [
              { id: 'explicit.stat_3299347043', min: 80, maxTier: 2 },
              { id: 'explicit.stat_2923486259', min: 26 },
            ],
          },
        ],
      },
    };
    const raw = rawTradeListing();
    const status = () =>
      analyzeBeltSnapshot(
        grouped,
        createImportedMarketSnapshot(
          {
            targetId: grouped.id,
            capturedAt: at.toISOString(),
            sourceUrl: 'https://example.com/demo',
            currency: 'chaos',
            dataKind: 'demo',
            listings: [normalizeTradeCompatibleListing(raw, grouped)],
          },
          grouped,
          at,
        ),
        at.getTime(),
      ).rows[0]?.status;
    expect(status()).toBe('MATCH');
    expect(
      generateMarketTradeQuery(grouped).request.query.stats[0],
    ).toMatchObject({ type: 'count', value: { min: 1 } });
    raw.item.extended.mods.explicit[0]!.tier = 'P3';
    expect(status()).toBe('REJECT');
    raw.item.extended.mods.explicit = [];
    expect(status()).toBe('PARTIAL');
  });

  it('bounds a timed-out request and does not retain transport error details', async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeout.signal);
    const requestSignals: AbortSignal[] = [];
    const fetcher: typeof fetch = async (_, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error('Missing request signal');
      requestSignals.push(signal);
      signal.throwIfAborted();
      return new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('private-session')),
          { once: true },
        );
      });
    };
    const transport = new TradeCompatibleTransport(
      { ...config, timeoutMs: 100 },
      { fetcher },
    );
    try {
      const request = transport.search({
        target: tradeTarget(),
        signal: new AbortController().signal,
      });
      timeout.abort();
      await expect(request).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        cause: undefined,
      });
      expect(timeoutSpy).toHaveBeenCalledWith(100);
      expect(transport.connectionStatus).toBe('UNAVAILABLE');
      expect(requestSignals[0]?.aborted).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
  it('generates deterministic strict/broad requests and rejects unknown mappings', () => {
    const target = tradeTarget();
    const strict = generateMarketTradeQuery(target);
    expect(
      generateMarketTradeQuery({ ...target, id: crypto.randomUUID() }).hash,
    ).toBe(strict.hash);
    expect(strict.request.query.type).toBe('Stygian Vise');
    expect(strict.request.query.status.option).toBe('available');
    expect(strict.request.sort.price).toBe('asc');
    const broad = generateMarketTradeQuery(target, 'broad');
    expect(broad.hash).not.toBe(strict.hash);
    expect(broad.request.query.stats[0]?.filters[0]?.value?.min).toBe(64);
    expect(() =>
      generateMarketTradeQuery({
        ...target,
        tradeSearch: {
          ...target.tradeSearch!,
          groups: [
            {
              type: 'and',
              filters: [{ id: 'explicit.not_a_mapping', min: 80 }],
            },
          ],
        },
      }),
    ).toThrow('The market query is invalid.');
    expect(() =>
      generateMarketTradeQuery({ ...target, baseTypes: ['A', 'B'] }),
    ).toThrow('The market query is invalid.');
  });

  it('normalizes actual rolls, tiers, raw observations and modifier origin', () => {
    const row = normalizeTradeCompatibleListing(
      rawTradeListing(),
      tradeTarget(),
    );
    expect(row.item.mods).toContainEqual({ id: 'life', value: 90, tier: 2 });
    expect(row.item.itemLevel).toBe(84);
    expect(
      normalizeTradeCompatibleListing(
        {
          ...rawTradeListing(),
          listing: {
            ...rawTradeListing().listing,
            fee: { amount: 4104, currency: 'gold' },
          },
        },
        tradeTarget(),
      ).fee,
    ).toBe(4104);
    expect(row.rawListing?.item).toHaveProperty(
      'extended.mods.explicit.0.magnitudes',
    );
    const malformed = rawTradeListing();
    malformed.item.extended.mods.explicit[0]!.tier = 'S0';
    expect(
      normalizeTradeCompatibleListing(malformed, tradeTarget()).item.mods,
    ).toContainEqual({ id: 'explicit.stat_3299347043', value: 90 });
    malformed.item.explicitMods = ['unexpected life format'];
    expect(
      normalizeTradeCompatibleListing(
        { ...malformed, item: { ...malformed.item, verified: true } },
        tradeTarget(),
      ).item.verifiedAbsentStats,
    ).not.toContain('explicit.stat_3299347043');
    expect(
      normalizeTradeCompatibleListing(malformed, tradeTarget()).item.mods,
    ).not.toContainEqual(expect.objectContaining({ id: 'life' }));
    expect(
      normalizeTradeCompatibleListing(
        { ...rawTradeListing(), listing: { account: { name: 'seller' } } },
        tradeTarget(),
      ).price,
    ).toBeNull();
  });

  it('uses POST search and batches of ten through the existing collection adapter', async () => {
    const ids = Array.from({ length: 13 }, (_, i) => `listing-${i}`);
    const queryId = 'H4sI' + 'a'.repeat(304);
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.headers).toMatchObject({
        Cookie: 'POESESSID=private-session',
      });
      if (String(url).includes('/search/'))
        return Response.json({ id: queryId, total: 13, result: ids });
      expect(new URL(String(url)).searchParams.get('query')).toBe(queryId);
      const batch =
        new URL(String(url)).pathname.split('/').at(-1)?.split(',') ?? [];
      return Response.json({ result: batch.map((id) => rawTradeListing(id)) });
    });
    const transport = new TradeCompatibleTransport(config, {
      fetcher,
      clock: () => at,
    });
    const source = createBatchedMarketCollectionSource({
      descriptor: {
        id: 'test',
        name: 'Synthetic',
        access: 'replay',
        dataKind: 'demo',
        reason: null,
      },
      transport,
      rateLimits: {
        waitForPermit: vi.fn(),
        observeResponse: vi.fn(),
      },
    });
    const batch = await source.collect({
      target: tradeTarget(),
      signal: new AbortController().signal,
    });
    expect(batch).toMatchObject({
      coverage: 'complete',
      fetchedCount: 13,
      batchCount: 2,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(transport.connectionStatus).toBe('CONNECTED');
    expect(JSON.stringify(batch)).not.toContain('private-session');
  });

  it.each([
    [401, 'AUTH_REQUIRED'],
    [403, 'ACCESS_DENIED'],
    [429, 'RATE_LIMITED'],
    [503, 'UNAVAILABLE'],
  ] as const)('reports HTTP %s safely', async (status, expected) => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response('private-session', {
          status,
          headers: { 'Retry-After': '7' },
        }),
    );
    const transport = new TradeCompatibleTransport(config, { fetcher });
    const response = await transport.search({
      target: tradeTarget(),
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(status);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(transport.connectionStatus).toBe(expected);
    if (status === 401 || status === 403) {
      await expect(
        transport.search({
          target: tradeTarget(),
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'MARKET_ACCESS_BLOCKED' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('retains cached capture time and redacts reflected credentials', async () => {
    let now = at;
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: 'query-1',
        total: 0,
        result: [],
        cookie: 'secret',
        reflected: 'private-session',
      }),
    );
    const transport = new TradeCompatibleTransport(config, {
      fetcher,
      clock: () => now,
    });
    const first = await transport.search({
      target: tradeTarget(),
      signal: new AbortController().signal,
    });
    now = new Date(at.getTime() + 1000);
    const second = await transport.search({
      target: tradeTarget(),
      signal: new AbortController().signal,
    });
    expect(second.cached).toBe(true);
    expect(second.data.capturedAt).toBe(first.data.capturedAt);
    expect(second.data.raw).toMatchObject({
      cookie: '[REDACTED]',
      reflected: '[REDACTED]',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fails closed on redirects, challenges and changed schemas', async () => {
    for (const response of [
      new Response(null, {
        status: 302,
        headers: { Location: 'https://example.com/' },
      }),
      new Response('challenge', { headers: { 'cf-mitigated': 'challenge' } }),
    ]) {
      const transport = new TradeCompatibleTransport(config, {
        fetcher: async (_, init) => {
          expect(init?.redirect).toBe('manual');
          return response;
        },
      });
      expect(
        (
          await transport.search({
            target: tradeTarget(),
            signal: new AbortController().signal,
          })
        ).status,
      ).toBe(403);
      expect(transport.connectionStatus).toBe('ACCESS_DENIED');
    }
    const transport = new TradeCompatibleTransport(config, {
      fetcher: async () => Response.json({ changed: true }),
    });
    await expect(
      transport.search({
        target: tradeTarget(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
  });

  it('never leaks invalid session values in configuration errors', () => {
    expect(() =>
      loadTradeCompatibleConfig({
        POE_TRADE_USER_AGENT: 'app-test',
        POE_TRADE_SESSION_ID: 'secret\nvalue',
      }),
    ).toThrow('Invalid Trade environment');
    expect(() =>
      loadTradeCompatibleConfig({
        POE_TRADE_USER_AGENT: 'app-test',
        POE_TRADE_BASE_URL: 'https://secret:password@example.com',
      }),
    ).toThrow('HTTPS origin without credentials');
  });
});

it('derives absent influences from full normal Trade items and revalidates historical raw observations', async () => {
  const capture = JSON.parse(
    await readFile(
      new URL(
        './fixtures/tradeCompatible/fetch.normal-cluster.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const target = createMarketTarget(capture.target);
  const normalized = normalizeTradeCompatibleListing(capture.result[0], target);
  expect(normalized.item.influences).toEqual([]);
  const legacyItem: Record<string, CanonicalJsonValue> = {
    ...normalized.item,
    normalizationVersion: 'trade-compatible-v2',
    rawListing: capture.result[0],
  };
  delete legacyItem.influences;
  const capturedAt = new Date('2026-11-02T15:10:53Z');
  const matches = comparableRecipeListings(
    { handbookTarget: JSON.stringify(capture.target) },
    [
      {
        id: 'normal-cluster-sanitized',
        account: 'sanitized-seller',
        ageSeconds: 0,
        indexedAt: capturedAt,
        fee: null,
        item: legacyItem,
        price: { amount: '9', currency: 'chaos' },
      },
    ],
    capturedAt,
    capturedAt,
  );
  expect(matches).toHaveLength(1);
  expect(matches[0]?.item.influences).toEqual([]);
  expect(matches[0]?.price).toEqual({ amount: '9', currency: 'chaos' });
  expect(legacyItem).not.toHaveProperty('influences');
});
