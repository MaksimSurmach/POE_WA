import { describe, expect, it } from 'vitest';
import {
  aggregateMarketListings,
  selectPriceEstimate,
} from '@poe-worksmith/domain';
import {
  expectedDefaultQueryHashes,
  expectedDefaultQueryKeys,
} from './integrationCatalog.js';
import { integrationScenario } from './integrationScenarios.js';

describe('integration scenarios', () =>
  it.each([
    ['all-success', 13, 12],
    ['publish-at-95', 11, 10],
    ['reject-below-95', 10, 9],
  ] as const)(
    '%s keeps one shared legacy query with %i raw and %i effective listings',
    async (name, raw, effective) => {
      const hashes = await expectedDefaultQueryHashes();
      const script = await integrationScenario(name);
      const step =
        script[
          hashes[expectedDefaultQueryKeys.indexOf('fixture:output:legacy')]!
        ]?.[0];
      expect(step?.type).toBe('success');
      const listings = step?.type === 'success' ? step.result.listings : [];
      expect(listings).toHaveLength(raw);
      const aggregation = aggregateMarketListings({
        currency: 'chaos',
        listings,
      });
      expect(aggregation.listings).toHaveLength(effective);
      expect(aggregation.listings[0]?.price.amount).toBe('70');
      expect(
        aggregation.listings.filter(
          ({ account }) => account === 'fixture-seller-0',
        ),
      ).toHaveLength(1);
      expect(
        selectPriceEstimate(aggregation, { strategy: 'median_top_n', n: 10 })
          .price,
      ).toEqual(effective >= 10 ? expect.any(Object) : null);
    },
  ));

it('keeps ten effective listings from an eleven-row normal result', async () => {
  const hashes = await expectedDefaultQueryHashes();
  const script = await integrationScenario('all-success');
  const step =
    script[hashes[expectedDefaultQueryKeys.indexOf('fixture:output:a')]!]?.[0];
  expect(step?.type).toBe('success');
  const listings = step?.type === 'success' ? step.result.listings : [];
  const aggregation = aggregateMarketListings({ currency: 'chaos', listings });
  expect(listings).toHaveLength(11);
  expect(aggregation.listings).toHaveLength(10);
  expect(
    selectPriceEstimate(aggregation, { strategy: 'median_top_n', n: 10 }).price,
  ).toEqual(expect.any(Object));
});
