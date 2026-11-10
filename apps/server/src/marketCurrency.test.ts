import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { convertMarketQuote } from './marketCurrency.js';
import { marketListingFixture } from './marketListingFixture.js';
import { createMarketTarget } from './marketResearch.js';
import type { StoredMarketEconomySnapshot } from './marketEconomy.js';
import {
  TradeCompatibleTransport,
  loadTradeCompatibleConfig,
} from './providers/tradeCompatible.js';

const at = new Date('2026-11-01T12:00:00.000Z');
const target = createMarketTarget(marketListingFixture(at).target);
const exchange: StoredMarketEconomySnapshot = {
  id: randomUUID(),
  schemaVersion: 1,
  kind: 'economy-overview',
  source: 'poe.ninja',
  game: 'poe1',
  league: target.league,
  category: 'Currency',
  endpoint:
    'https://poe.ninja/poe1/api/economy/exchange/current/overview?league=Demo&type=Currency',
  payloadHash: 'a'.repeat(64),
  capturedAt: at.toISOString(),
  sourceUpdatedAt: null,
  priceBasis: 'currency-exchange',
  raw: { fixture: true },
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

describe('observed exchange provenance', () => {
  it('converts in both directions only with a same-league contemporaneous exchange observation', async () => {
    const input = {
      money: { amount: '2.5', currency: 'divine' },
      currency: 'chaos' as const,
      target,
      capturedAt: at.toISOString(),
      exchangeSnapshotId: exchange.id,
      economy: { find: async () => exchange },
      now: at.getTime(),
      dataKind: 'observed' as const,
    };
    expect(await convertMarketQuote(input)).toMatchObject({
      money: { amount: '500', currency: 'chaos' },
      exchange: { snapshotId: exchange.id, chaosPerDivine: 200 },
    });
    expect(
      await convertMarketQuote({
        ...input,
        money: { amount: '500', currency: 'chaos' },
        currency: 'divine',
      }),
    ).toMatchObject({ money: { amount: '2.5', currency: 'divine' } });
    const { exchangeSnapshotId, ...withoutExchange } = input;
    expect(exchangeSnapshotId).toBe(exchange.id);
    expect(await convertMarketQuote(withoutExchange)).toBeNull();
    expect(await convertMarketQuote({ ...input, dataKind: 'demo' })).toBeNull();
    expect(
      await convertMarketQuote({
        ...input,
        target: { ...target, league: 'New League' },
      }),
    ).toBeNull();
    expect(
      await convertMarketQuote({
        ...input,
        now: at.getTime() + 2 * 86_400_000,
      }),
    ).toBeNull();
    expect(
      await convertMarketQuote({
        ...input,
        economy: { find: async () => ({ ...exchange, category: 'Essence' }) },
      }),
    ).toBeNull();
    expect(
      await convertMarketQuote({
        ...input,
        capturedAt: new Date(at.getTime() - 2 * 86_400_000).toISOString(),
      }),
    ).toBeNull();
  });

  it('normalizes a mixed-currency listing while retaining its original asking price and exact exchange source', async () => {
    const scoped = createMarketTarget({
      ...marketListingFixture(at).target,
      tradeSearch: {
        version: 1,
        scope: 'strict',
        rarity: 'rare',
        status: 'available',
        currency: 'chaos',
        exchangeSnapshotId: exchange.id,
        groups: [
          {
            type: 'and',
            filters: [{ id: 'explicit.stat_3299347043', min: 80 }],
          },
        ],
      },
    });
    const raw = {
      id: 'mixed-listing',
      listing: {
        price: { amount: 2.5, currency: 'divine', type: '~price' },
        account: { name: 'synthetic-seller' },
        indexed: at.toISOString(),
      },
      item: {
        baseType: 'Stygian Vise',
        league: 'Demo',
        ilvl: 84,
        frameType: 2,
        corrupted: false,
        explicitMods: ['+90 to maximum Life'],
        extraUnknownField: 'retained',
        extended: { unknownFutureField: 'retained' },
      },
    };
    const transport = new TradeCompatibleTransport(
      loadTradeCompatibleConfig({
        POE_TRADE_USER_AGENT: 'fixture exchange test',
      }),
      {
        clock: () => at,
        economy: { find: async () => exchange },
        fetcher: async (url) =>
          String(url).includes('/search/')
            ? Response.json({ id: 'q1', total: 1, result: ['mixed-listing'] })
            : Response.json({ result: [raw] }),
      },
    );
    const signal = new AbortController().signal;
    const search = await transport.search({ target: scoped, signal });
    const result = await transport.fetchDetails({
      ids: ['mixed-listing'],
      queryId: search.data.queryId,
      signal,
    });
    expect(result.data[0]).toMatchObject({
      price: 500,
      currency: 'chaos',
      item: {
        originalCurrency: 'divine',
        originalPrice: 2.5,
        exchange: { snapshotId: exchange.id },
      },
      rawListing: raw,
    });
  });
});
