import {
  aggregateMarketListings,
  selectPriceEstimate,
  type MarketListing,
} from '@poe-worksmith/domain';
import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  expectedDefaultQueryHashes,
  expectedDefaultQueryKeys,
  integrationRecipeIds,
  loadIntegrationCatalog,
} from './integrationCatalog.js';

const listings = (count: number): MarketListing[] =>
  Array.from({ length: count }, (_, index) => ({
    account: `fixture-seller-${index < 2 ? 0 : index}`,
    ageSeconds: index,
    fee: null,
    id: `fixture-${index}`,
    indexedAt: new Date('2026-07-20T12:00:00.000Z'),
    item: {},
    price: { amount: String(70 + index * 2), currency: 'chaos' },
  }));
const availability = (
  count: number,
  estimator: Parameters<typeof selectPriceEstimate>[1],
) =>
  selectPriceEstimate(
    aggregateMarketListings({ currency: 'chaos', listings: listings(count) }),
    estimator,
  ).reason;

describe('integration catalog', () => {
  it('has the exact unique 20-recipe v1/v2 matrix and query manifest', async () => {
    const recipes = await loadIntegrationCatalog();
    expect(recipes).toHaveLength(20);
    expect(recipes.map(({ definition }) => definition.id).sort()).toEqual(
      [...integrationRecipeIds].sort(),
    );
    expect(
      recipes.filter(({ definition }) => definition.schemaVersion === 2),
    ).toHaveLength(16);
    expect(
      recipes.filter(({ definition }) => definition.schemaVersion === 1),
    ).toHaveLength(4);
    expect(new Set(await expectedDefaultQueryHashes())).toHaveLength(
      expectedDefaultQueryKeys.length,
    );
  });
  it('loads 19 checked-in synthetic sources deterministically', async () => {
    const directory = new URL('./recipes/', import.meta.url);
    expect(
      (await readdir(directory)).filter((file) => file.endsWith('.md')),
    ).toHaveLength(19);
    const first = await loadIntegrationCatalog();
    const second = await loadIntegrationCatalog();
    expect(
      first.map(({ definition, markdown }) => ({ definition, markdown })),
    ).toEqual(
      second.map(({ definition, markdown }) => ({ definition, markdown })),
    );
  });
  it.each([
    [12, [null, null, null, null]],
    [10, [null, null, 'insufficient_listings', 'insufficient_listings']],
    [9, [null, null, 'insufficient_listings', 'insufficient_listings']],
  ] as const)(
    'uses estimator listing thresholds for %i listings',
    (count, expected) => {
      const estimators = [
        { strategy: 'cheapest' },
        { strategy: 'nth_cheapest', n: 3 },
        { strategy: 'median_top_n', n: 10 },
        { strategy: 'mean_top_n', n: 11 },
      ] as const;
      expect(
        estimators.map((estimator) => availability(count, estimator)),
      ).toEqual(expected);
    },
  );
});
