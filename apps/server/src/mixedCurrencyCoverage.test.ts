import { describe, expect, it } from 'vitest';
import { createMarketTarget } from './marketResearch.js';
import {
  createBatchedMarketCollectionSource,
  type MarketCollectionBatch,
} from './marketCollection.js';
import { PoeTradeClient } from './providers/poeTrade.js';
import { requiresCompleteOutputCoverage } from './recipeMarket.js';
import type { RateLimitGate } from './rateLimitController.js';

const targetInput = {
  name: 'Mixed output',
  game: 'poe1',
  realm: 'pc',
  league: 'Fixture League',
  patch: '3.29',
  slot: 'crafted-item',
  baseTypes: ['Quicksilver Flask'],
  builds: [],
  requiredMods: [],
  sources: [],
  tradeSearch: {
    version: 1,
    scope: 'strict',
    status: 'securable',
    currency: 'chaos',
    includeOtherCurrencies: true,
    rarity: 'magic',
    groups: [],
  },
};
const target = createMarketTarget(targetInput);
const descriptor = {
  id: 'fixture',
  name: 'Fixture',
  access: 'authorized' as const,
  dataKind: 'observed' as const,
  reason: null,
};
const query = { handbookTarget: JSON.stringify(targetInput) };

async function collect(
  count: number,
  slot = 'crafted-item',
  inexact = false,
  interrupt = false,
  reportedTotal: number | null = count,
) {
  const ids = Array.from({ length: count }, (_, i) => `item-${i}`);
  const controller = new AbortController();
  const source = createBatchedMarketCollectionSource({
    descriptor,
    rateLimits: {
      async waitForPermit() {
        return {};
      },
      async observeResponse() {
        return {};
      },
    } as unknown as RateLimitGate,
    transport: {
      async search() {
        return {
          status: 200,
          cached: false,
          headers: new Headers(),
          data: {
            capturedAt: '2026-11-04T12:00:00Z',
            coverage: 'complete' as const,
            currency: 'chaos',
            ids,
            queryId: 'q',
            reportedTotal,
            inexact,
            request: { scope: 'strict', sort: { price: 'asc' } },
          },
        };
      },
      async fetchDetails({ ids: page }) {
        if (interrupt && page.includes('item-20')) controller.abort();
        return {
          status: 200,
          cached: false,
          headers: new Headers(),
          data: page.map((externalId) => ({
            externalId,
            price: externalId === 'item-20' ? 650 : 810.4,
            currency: 'chaos',
            item: {
              seller: externalId,
              originalCurrency: externalId === 'item-20' ? 'chaos' : 'divine',
            },
          })),
        };
      },
    },
  });
  return source.collect({
    target: { ...target, slot },
    signal: controller.signal,
  });
}

describe('mixed currency output coverage', () => {
  it('finds the cheaper chaos ask after twenty converted divine asks', async () => {
    expect(requiresCompleteOutputCoverage(query)).toBe(true);
    const batch = await collect(31);
    expect(batch).toMatchObject({
      coverage: 'complete',
      fetchedCount: 31,
      sortedSampleComplete: false,
    });
    expect(Math.min(...batch.listings.map((x) => x.price!))).toBe(650);
  });
  it.each([
    [101, false, false, 20],
    [31, true, false, 31],
    [31, false, true, 30],
  ] as const)(
    'does not certify capped, inexact or interrupted outputs: %s/%s/%s',
    async (count, inexact, interrupt, fetched) => {
      const batch = await collect(count, 'crafted-item', inexact, interrupt);
      expect(batch).toMatchObject({
        coverage: 'partial',
        fetchedCount: fetched,
        sortedSampleComplete: false,
      });
    },
  );
  it.each([
    [100, 100, 100, 'complete'],
    [100, 101, 20, 'partial'],
    [101, null, 20, 'partial'],
    [0, 101, 0, 'partial'],
  ] as const)(
    'keeps a bounded detail sample and search evidence for oversized outputs: %s IDs / %s total',
    async (count, total, fetched, coverage) => {
      const batch = await collect(count, 'crafted-item', false, false, total);
      expect(batch).toMatchObject({
        batchCount: fetched / 10,
        coverage,
        fetchedCount: fetched,
        returnedCount: count,
        reportedTotal: total,
        sortedSampleComplete: false,
        searchEvidence: { queryId: 'q', reportedTotal: total },
      });
      expect(batch.searchEvidence?.ids).toHaveLength(count);
      expect(batch.errorCode).toBeUndefined();
      const provider = new PoeTradeClient({
        userAgent: 'fixture coverage',
        collectionSource: { descriptor, collect: async () => batch },
      });
      const result = await provider.search({
        league: target.league,
        query,
        schemaVersion: 1,
      });
      expect(result).toMatchObject({
        coverage,
        totalResults: total ?? count,
      });
      expect(result.listings).toHaveLength(fetched);
    },
  );
  it.each([
    ['crafted-item', 100],
    ['starting-base', 101],
  ] as const)(
    'still rejects an unexpectedly empty %s collection',
    async (slot, reportedTotal) => {
      const batch = {
        ...(await collect(101)),
        reportedTotal,
        fetchedCount: 0,
        listings: [],
      };
      const provider = new PoeTradeClient({
        userAgent: 'fixture coverage',
        collectionSource: {
          descriptor,
          collect: async () => ({ ...batch, returnedCount: reportedTotal }),
        },
      });
      await expect(
        provider.search({
          league: target.league,
          query: { handbookTarget: JSON.stringify({ ...targetInput, slot }) },
          schemaVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'MARKET_COLLECTION_FAILED' });
    },
  );
  it('retains the bounded available-purchase sample for starting bases', async () => {
    const batch = await collect(101, 'starting-base');
    expect(batch).toMatchObject({
      fetchedCount: 20,
      coverage: 'partial',
      sortedSampleComplete: true,
    });
  });
  it.each([undefined, true])(
    'rejects legacy page/sample proof in the provider adapter: %s',
    async (proof) => {
      const full = await collect(31);
      const legacy: MarketCollectionBatch = {
        ...full,
        coverage: 'partial',
        reportedTotal: 100,
        ...(proof === undefined ? {} : { sortedSampleComplete: proof }),
      };
      if (proof === undefined) delete legacy.sortedSampleComplete;
      const provider = new PoeTradeClient({
        userAgent: 'fixture coverage',
        collectionSource: {
          descriptor,
          async collect() {
            return legacy;
          },
        },
      });
      const result = await provider.search({
        league: target.league,
        query,
        schemaVersion: 1,
      });
      expect(result).toMatchObject({
        coverage: 'partial',
        sortedPageComplete: false,
        sortedSampleComplete: false,
      });
    },
  );
});
