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
            reportedTotal: count,
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
    [101, false, false, 100],
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
