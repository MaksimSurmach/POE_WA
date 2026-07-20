import { describe, expect, it } from 'vitest';

import { profitableRecipeDetail, recipeDetails } from './recipeDetails.js';

describe('recipe detail fixtures', () => {
  it('validates every catalog recipe and preserves all Merchant offers', () => {
    expect(recipeDetails).toHaveLength(7);
    expect(profitableRecipeDetail.snapshot?.listings).toHaveLength(10);
    expect(
      profitableRecipeDetail.snapshot?.listings.filter(
        ({ seller }) => seller === 'merchant-a',
      ),
    ).toHaveLength(3);
    expect(
      new Set(recipeDetails.map(({ evaluation }) => evaluation.status)),
    ).toEqual(new Set(['success', 'stale', 'loading', 'partial', 'error']));

    const breakdown = profitableRecipeDetail.costBreakdown;
    expect(breakdown).not.toBeNull();
    expect(
      (breakdown?.baseCost.amount ?? 0) +
        (breakdown?.materialsPerAttempt.amount ?? 0) *
          (breakdown?.expectedAttempts ?? 0) +
        (breakdown?.finishingCost.amount ?? 0),
    ).toBe(breakdown?.expectedCost.amount);
  });
});
