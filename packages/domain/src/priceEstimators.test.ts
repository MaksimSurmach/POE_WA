import { describe, expect, it } from 'vitest';

import type { MarketListing } from './marketProviders.js';
import {
  aggregateMarketListings,
  estimateSaleAsk,
  selectPriceEstimate,
} from './priceEstimators.js';

function listing(
  id: string,
  amount: number,
  options: { account?: string; ageSeconds?: number } = {},
): MarketListing {
  return {
    account: options.account ?? `seller-${id}`,
    ageSeconds: options.ageSeconds ?? 60,
    fee: null,
    id,
    indexedAt: new Date('2026-07-20T00:00:00.000Z'),
    item: {},
    price: { amount: String(amount), currency: 'chaos' },
  };
}

describe('market snapshot aggregation', () => {
  it('keeps the cheapest listing for each seller', () => {
    const listings = [
      listing('outlier', 100, { ageSeconds: 8 * 24 * 60 * 60 }),
      listing('equal-b', 2, {
        account: 'SAME-SELLER',
        ageSeconds: 25 * 60 * 60,
      }),
      listing('cheap', 1, { ageSeconds: 30 * 60 }),
      listing('equal-a', 2, {
        account: 'same-seller',
        ageSeconds: 2 * 60 * 60,
      }),
      listing('middle', 4, { ageSeconds: 7 * 24 * 60 * 60 }),
      listing('three', 3, { ageSeconds: 6 * 24 * 60 * 60 }),
      listing('five', 5),
      listing('six', 6),
      listing('seven', 7),
      listing('eight', 8),
    ];

    const result = aggregateMarketListings({
      currency: 'chaos',
      listings,
      totalListings: 42,
    });
    const reordered = aggregateMarketListings({
      currency: 'chaos',
      listings: [...listings].reverse(),
      totalListings: 42,
    });

    expect(result).toEqual(reordered);
    expect(result.listings).toHaveLength(9);
    expect(
      result.listings.filter(({ account }) => account === 'same-seller'),
    ).toEqual([
      expect.objectContaining({
        id: 'equal-a',
        price: { amount: '2', currency: 'chaos' },
      }),
    ]);
    expect(result).toMatchObject({
      ageBuckets: {
        atLeastSevenDays: 2,
        oneDayToSevenDays: 1,
        oneHourToOneDay: 1,
        underOneHour: 5,
      },
      cheapest: { amount: '1', currency: 'chaos' },
      medianTopFive: { amount: '3', currency: 'chaos' },
      medianTopTen: null,
      sampleSize: 9,
      secondCheapest: { amount: '2', currency: 'chaos' },
      thirdCheapest: { amount: '3', currency: 'chaos' },
      totalListings: 42,
    });
    expect(
      result.estimators.find(({ id }) => id === 'mean-top-5'),
    ).toMatchObject({ price: { amount: '3' }, reason: null });
    expect(
      result.estimators.find(({ id }) => id === 'percentile-50'),
    ).toMatchObject({ price: { amount: '5' }, reason: null });
  });

  it('keeps an old cheapest listing in estimator calculations', () => {
    const result = aggregateMarketListings({
      currency: 'chaos',
      listings: [
        listing('new', 10),
        listing('old', 1, { ageSeconds: 30 * 24 * 60 * 60 }),
      ],
    });

    expect(result.cheapest?.amount).toBe('1');
    expect(
      selectPriceEstimate(result, { strategy: 'cheapest' }).price?.amount,
    ).toBe('1');
    expect(result.ageBuckets.atLeastSevenDays).toBe(1);
  });

  it('returns explicit empty and insufficient estimator results', () => {
    const empty = aggregateMarketListings({ currency: 'chaos', listings: [] });
    expect(empty.cheapest).toBeNull();
    expect(
      empty.estimators.every(({ reason }) => reason === 'no_listings'),
    ).toBe(true);

    const sparse = aggregateMarketListings({
      currency: 'chaos',
      listings: [listing('one', 1), listing('two', 2)],
    });
    expect(
      selectPriceEstimate(sparse, { n: 5, strategy: 'median_top_n' }),
    ).toMatchObject({
      price: null,
      reason: 'insufficient_listings',
      requiredListings: 5,
    });
    expect(sparse.thirdCheapest).toBeNull();
    expect(sparse.medianTopFive).toBeNull();
  });

  it('selects every recipe estimator strategy through the plugin registry', () => {
    const result = aggregateMarketListings({
      currency: 'chaos',
      listings: [1, 2, 3, 4, 100].map((amount) =>
        listing(String(amount), amount),
      ),
    });
    const cases = [
      [{ strategy: 'cheapest' } as const, '1'],
      [{ n: 3, strategy: 'nth_cheapest' } as const, '3'],
      [{ n: 5, strategy: 'median_top_n' } as const, '3'],
      [{ n: 5, strategy: 'mean_top_n' } as const, '22'],
      [{ percentile: 50, strategy: 'percentile' } as const, '3'],
    ] as const;

    for (const [configuration, expected] of cases) {
      expect(selectPriceEstimate(result, configuration).price?.amount).toBe(
        expected,
      );
    }

    expect(
      selectPriceEstimate(result, { strategy: 'cheapest' }, [
        {
          strategy: 'cheapest',
          estimate: () => 42,
          label: () => 'Custom estimator',
          requiredListings: () => 1,
        },
      ]),
    ).toMatchObject({
      label: 'Custom estimator',
      price: { amount: '42', currency: 'chaos' },
    });
  });

  it('interpolates percentiles and averages the middle pair for even samples', () => {
    const result = aggregateMarketListings({
      currency: 'chaos',
      listings: [listing('high', 30), listing('low', 10)],
    });
    expect(
      selectPriceEstimate(result, { strategy: 'percentile', percentile: 25 })
        .price?.amount,
    ).toBe('15');
    expect(
      selectPriceEstimate(result, { strategy: 'percentile', percentile: 100 })
        .price?.amount,
    ).toBe('30');
    expect(
      selectPriceEstimate(result, { strategy: 'median_top_n', n: 2 }).price
        ?.amount,
    ).toBe('20');
  });

  it('rejects mixed currency and invalid total counts', () => {
    const mixed = {
      ...listing('mixed', 1),
      price: { amount: '1', currency: 'divine' },
    };
    expect(() =>
      aggregateMarketListings({ currency: 'chaos', listings: [mixed] }),
    ).toThrow(/unsupported currency/i);
    expect(() =>
      aggregateMarketListings({
        currency: 'chaos',
        listings: [listing('one', 1)],
        totalListings: 0,
      }),
    ).toThrow(/invalid calculation inputs/i);
  });
});

describe('sale ask', () => {
  it.each([
    {
      name: 'skips an outlier with six distinct sellers',
      asks: [1, 100, 105, 110, 120, 130],
      price: { amount: '100', currency: 'chaos' },
      basis: 'cheapest-after-outlier',
      ignoredOutliers: 1,
    },
    {
      name: 'skips multiple outliers and formats the selected ask',
      asks: [1, 2, 100.123456789, 110, 120],
      price: { amount: '100.12345679', currency: 'chaos' },
      basis: 'cheapest-after-outlier',
      ignoredOutliers: 2,
    },
    {
      name: 'keeps an ask exactly half the median of the five cheapest',
      asks: [50, 90, 100, 110, 120, 130],
      price: { amount: '50', currency: 'chaos' },
      basis: 'cheapest',
      ignoredOutliers: 0,
    },
    {
      name: 'keeps the cheapest ask with three sellers',
      asks: [100, 105, 110],
      price: { amount: '100', currency: 'chaos' },
      basis: 'cheapest',
      ignoredOutliers: 0,
    },
    {
      name: 'returns no ask for an empty sample',
      asks: [],
      price: null,
      basis: 'none',
      ignoredOutliers: 0,
    },
  ])('$name', ({ asks, price, basis, ignoredOutliers }) => {
    const aggregation = aggregateMarketListings({
      currency: 'chaos',
      listings: asks.map((amount, index) => listing(String(index), amount)),
    });

    expect(estimateSaleAsk(aggregation)).toEqual({
      price,
      basis,
      ignoredOutliers,
    });
  });

  it('uses the cheapest ask after deduplicating sellers', () => {
    const aggregation = aggregateMarketListings({
      currency: 'chaos',
      listings: [
        listing('one-higher', 110, { account: 'Seller One' }),
        listing('two', 100),
        listing('one-cheapest', 1, { account: ' seller one ' }),
      ],
    });

    expect(aggregation.sampleSize).toBe(2);
    expect(estimateSaleAsk(aggregation)).toEqual({
      price: { amount: '1', currency: 'chaos' },
      basis: 'cheapest',
      ignoredOutliers: 0,
    });
  });
});
