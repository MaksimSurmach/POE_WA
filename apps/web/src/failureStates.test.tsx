import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  FailureStatePanel,
  knownFailureCodes,
  RecipeStatePanel,
} from './failureStates.js';

const lastSuccessfulAt = '2026-07-18T00:01:00.000Z';

describe('failure-state matrix', () => {
  it('renders a scoped recovery panel for every known error code', () => {
    for (const errorCode of knownFailureCodes) {
      const markup = renderToStaticMarkup(
        <FailureStatePanel
          errorCode={errorCode}
          lastSuccessfulAt={null}
          scope="recipe"
        />,
      );

      expect(markup).toContain(`data-error-code="${errorCode}"`);
      expect(markup).toContain('<h2>');
      expect(markup).not.toContain('<h2></h2>');
    }
  });

  it.each([
    {
      evaluation: {
        errorCode: null,
        evaluatedAt: null,
        estimatedSalePrice: null,
        expectedCraftCost: null,
        lastSuccessfulAt: null,
        marginPercent: null,
        profit: null,
        recipeId: 'loading',
        snapshotId: null,
        status: 'loading' as const,
      },
      state: 'no-data',
    },
    {
      evaluation: {
        errorCode: 'PROVIDER_UNAVAILABLE' as const,
        evaluatedAt: lastSuccessfulAt,
        estimatedSalePrice: { amount: 4.5, currency: 'divine' as const },
        expectedCraftCost: { amount: 2.7, currency: 'divine' as const },
        lastSuccessfulAt,
        marginPercent: 40,
        profit: { amount: 1.8, currency: 'divine' as const },
        recipeId: 'stale',
        snapshotId: 'snapshot-stale',
        status: 'stale' as const,
      },
      state: 'stale-provider',
    },
    {
      evaluation: {
        errorCode: 'NO_LISTINGS' as const,
        evaluatedAt: lastSuccessfulAt,
        estimatedSalePrice: null,
        expectedCraftCost: { amount: 3.2, currency: 'divine' as const },
        lastSuccessfulAt: null,
        marginPercent: null,
        profit: null,
        recipeId: 'partial',
        snapshotId: 'snapshot-empty',
        status: 'partial' as const,
      },
      state: 'partial-no-listings',
    },
    {
      evaluation: {
        errorCode: 'RECIPE_INVALID' as const,
        evaluatedAt: null,
        estimatedSalePrice: null,
        expectedCraftCost: null,
        lastSuccessfulAt: null,
        marginPercent: null,
        profit: null,
        recipeId: 'invalid',
        snapshotId: null,
        status: 'error' as const,
      },
      state: 'invalid-recipe',
    },
  ])('matches the $state component snapshot', ({ evaluation }) => {
    expect(
      renderToStaticMarkup(<RecipeStatePanel evaluation={evaluation} />),
    ).toMatchSnapshot();
  });
});
