import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { validRecipeV1Fixture } from './fixtures/recipes.js';
import type { MarketListing } from './marketProviders.js';
import { aggregateMarketListings } from './priceEstimators.js';
import { calculateRecipeEconomics } from './economics.js';
import { validateRecipeV1 } from './recipeSchema.js';

function aggregation(prices: readonly number[]) {
  const listings: MarketListing[] = prices.map((amount, index) => ({
    account: `seller-${index}`,
    ageSeconds: index * 60,
    fee: null,
    id: `listing-${index}`,
    indexedAt: new Date('2026-07-20T00:00:00.000Z'),
    item: {},
    price: { amount: String(amount), currency: 'chaos' },
  }));
  return aggregateMarketListings({ currency: 'chaos', listings });
}

function recipe(
  overrides: {
    estimator?: Record<string, unknown>;
    finishingQuantity?: number;
    materialQuantity?: number;
    success?: Record<string, unknown>;
  } = {},
) {
  return validateRecipeV1({
    ...validRecipeV1Fixture,
    estimator: overrides.estimator ?? { strategy: 'cheapest' },
    finishingCosts: validRecipeV1Fixture.finishingCosts.map((item) => ({
      ...item,
      quantity: overrides.finishingQuantity ?? item.quantity,
    })),
    materials: validRecipeV1Fixture.materials.map((item) => ({
      ...item,
      quantityPerAttempt: overrides.materialQuantity ?? item.quantityPerAttempt,
    })),
    success: overrides.success ?? validRecipeV1Fixture.success,
  });
}

const prices = {
  basePrice: { amount: '10', currency: 'chaos' },
  finishingPrices: {
    'divine-orb': { amount: '2', currency: 'chaos' },
  },
  materialPrices: {
    'primal-crystallised-lifeforce': { amount: '0.1', currency: 'chaos' },
  },
} as const;

describe('recipe economics', () => {
  it.each([
    {
      expected: {
        attempts: '3',
        craftCost: '57',
        margin: '75.43859649',
        profit: '43',
        sale: '100',
      },
      name: 'deterministic expected attempts',
      recipe: recipe({
        success: { expectedAttempts: 3, mode: 'expected_attempts' },
      }),
    },
    {
      expected: {
        attempts: '4',
        craftCost: '72',
        margin: '38.88888889',
        profit: '28',
        sale: '100',
      },
      name: 'geometric probability',
      recipe: recipe({ success: { mode: 'probability', probability: 0.25 } }),
    },
    {
      expected: {
        attempts: '6',
        craftCost: '102',
        margin: '194.11764706',
        profit: '198',
        sale: '300',
      },
      name: 'recipe-selected nth estimator',
      recipe: recipe({ estimator: { n: 3, strategy: 'nth_cheapest' } }),
    },
  ])('$name', ({ expected, recipe: definition }) => {
    const result = calculateRecipeEconomics({
      aggregation: aggregation([100, 200, 300]),
      ...prices,
      currency: 'chaos',
      recipe: definition,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      breakdown: {
        expectedAttempts: expected.attempts,
        expectedCraftCost: { amount: expected.craftCost },
      },
      estimatedSalePrice: { amount: expected.sale },
      marginPercent: expected.margin,
      profit: { amount: expected.profit },
    });
  });

  it('uses exact decimal arithmetic and a reproducible breakdown', () => {
    const result = calculateRecipeEconomics({
      aggregation: aggregation([1]),
      basePrice: { amount: '0.1', currency: 'chaos' },
      currency: 'chaos',
      finishingPrices: {
        'divine-orb': { amount: '0.2', currency: 'chaos' },
      },
      materialPrices: {
        'primal-crystallised-lifeforce': {
          amount: '0.2',
          currency: 'chaos',
        },
      },
      recipe: recipe({
        finishingQuantity: 0.1,
        materialQuantity: 0.1,
        success: { expectedAttempts: 3, mode: 'expected_attempts' },
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.breakdown).toMatchObject({
      expectedCraftCost: { amount: '0.18' },
      expectedMaterials: { amount: '0.06' },
      finishingTotal: { amount: '0.02' },
      materialsPerAttempt: { amount: '0.02' },
    });
    const reconstructed = new Decimal(result.value.breakdown.base.total.amount)
      .add(result.value.breakdown.expectedMaterials.amount)
      .add(result.value.breakdown.finishingTotal.amount)
      .toString();
    expect(reconstructed).toBe(result.value.breakdown.expectedCraftCost.amount);
    expect(result.value.profit.amount).toBe('0.82');
  });

  it('returns all missing inputs and never treats zero as a price', () => {
    const definition = recipe();
    const result = calculateRecipeEconomics({
      aggregation: aggregation([0]),
      basePrice: { amount: '0', currency: 'chaos' },
      currency: 'chaos',
      finishingPrices: { 'divine-orb': null },
      materialPrices: { 'primal-crystallised-lifeforce': null },
      recipe: definition,
    });

    expect(result).toMatchObject({
      errorCode: 'MATERIAL_PRICE_MISSING',
      ok: false,
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'base_price_missing' }),
        expect.objectContaining({ code: 'material_price_missing' }),
        expect.objectContaining({ code: 'finishing_price_missing' }),
        expect.objectContaining({ code: 'sale_price_missing' }),
      ]),
    });
    expect(result).not.toHaveProperty('value.profit');
  });

  it('reports no listings and currency mismatches explicitly', () => {
    const noListings = calculateRecipeEconomics({
      aggregation: aggregation([]),
      ...prices,
      currency: 'chaos',
      recipe: recipe(),
    });
    expect(noListings).toMatchObject({
      errorCode: 'NO_LISTINGS',
      ok: false,
      reasons: [expect.objectContaining({ code: 'sale_price_missing' })],
    });

    const mismatch = calculateRecipeEconomics({
      aggregation: aggregation([100]),
      ...prices,
      basePrice: { amount: '10', currency: 'divine' },
      currency: 'chaos',
      recipe: recipe(),
    });
    expect(mismatch).toMatchObject({
      errorCode: 'UNSUPPORTED_CURRENCY',
      ok: false,
      reasons: [expect.objectContaining({ code: 'currency_mismatch' })],
    });
  });
});
