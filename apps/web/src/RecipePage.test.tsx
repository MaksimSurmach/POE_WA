import type { CatalogEntry, CatalogResponse } from '@poe-worksmith/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import {
  MethodsForTarget,
  shouldRefreshMethodComparison,
} from './RecipePage.js';
import { catalogFixtures } from './mocks/catalog.js';

function comparisonEntry(
  id: string,
  craftMethod: string,
  targetSignature: string,
  evaluation: Partial<CatalogEntry['evaluation']>,
): CatalogEntry {
  const fixture = catalogFixtures[0]!;
  return {
    ...fixture,
    recipe: { ...fixture.recipe, id, craftMethod, targetSignature },
    evaluation: { ...fixture.evaluation, recipeId: id, ...evaluation },
  };
}

const blocked = comparisonEntry('blocked', 'essence', 'cluster', {
  status: 'partial',
  estimatedSalePrice: null,
  profit: null,
  marginPercent: null,
  profitBlockedReason: 'No matching Trade sellers.',
});
const fossil = comparisonEntry('fossil', 'fossil', 'cluster', {
  expectedCraftCost: { amount: 9, currency: 'divine' },
  estimatedSalePrice: { amount: 8, currency: 'divine' },
  profit: { amount: -1, currency: 'divine' },
  marginPercent: -11.11,
});
const chaos = comparisonEntry('chaos', 'chaos', 'cluster', {
  expectedCraftCost: { amount: 5, currency: 'divine' },
  estimatedSalePrice: { amount: 8, currency: 'divine' },
  profit: { amount: 3, currency: 'divine' },
  marginPercent: 60,
  budget: {
    p50: { amount: 4, currency: 'divine' },
    p90: { amount: 12, currency: 'divine' },
  },
  grade: 'A',
});
const unique = comparisonEntry('unique', 'harvest', 'ring', {
  profit: { amount: 100, currency: 'divine' },
});

function renderMethods(entries: CatalogEntry[], targetSignature: string) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MethodsForTarget entries={entries} targetSignature={targetSignature} />
    </MemoryRouter>,
  );
}

describe('recipe page method comparison', () => {
  it('ranks the priced methods for the target and shows why a method is blocked', () => {
    const html = renderMethods([blocked, fossil, chaos, unique], 'cluster');
    const links = [...html.matchAll(/href="\/recipes\/([^"]+)"/g)].map(
      ([, id]) => id,
    );

    expect(html).toContain('Methods for this target');
    expect(links).toEqual(['chaos', 'fossil', 'blocked']);
    expect(html).toMatch(
      /\/recipes\/chaos.*Best by expected profit.*5 div.*8 div.*\+3 div.*60\.0%.*4 div.*12 div.*Evidence grade A/,
    );
    expect(html).toContain('No matching Trade sellers.');
  });

  it('omits the comparison for a unique target', () => {
    expect(renderMethods([blocked, fossil, chaos, unique], 'ring')).toBe('');
  });

  it('does not mark a best method when every method is blocked', () => {
    const html = renderMethods(
      [
        blocked,
        comparisonEntry('unpriced', 'chaos', 'cluster', { profit: null }),
      ],
      'cluster',
    );
    expect(html).toContain('Methods for this target');
    expect(html).not.toContain('Best by expected profit');
  });
});

it('identifies expired and unpriced methods without blocking usable fallback profit', () => {
  const html = renderMethods(
    [
      { ...chaos, evaluation: { ...chaos.evaluation, status: 'stale' } },
      comparisonEntry('expired', 'fossil', 'cluster', {
        status: 'stale',
        profit: null,
        marginPercent: null,
      }),
      comparisonEntry('pending', 'harvest', 'cluster', {
        status: 'loading',
        profit: null,
        marginPercent: null,
      }),
    ],
    'cluster',
  );
  expect(html).toMatch(/\/recipes\/chaos.*Best by expected profit/);
  expect(html).toContain('Only stale market data is available.');
  expect(html).toContain('No market snapshot is available.');
});

it('revalidates existing or unavailable comparisons and checks unique targets after publication', () => {
  const publishedAt = '2026-11-10T00:00:00.000Z';
  const catalog: CatalogResponse = {
    correlationId: '33333333-3333-4333-8333-333333333333',
    data: { entries: [fossil, chaos, unique] },
    errorCode: null,
    isStale: false,
    lastSuccessfulAt: publishedAt,
    publishedAt,
    refreshStatus: 'published',
    state: 'success',
  };

  expect(shouldRefreshMethodComparison(catalog, 'cluster', publishedAt)).toBe(
    true,
  );
  expect(shouldRefreshMethodComparison(catalog, 'ring', publishedAt)).toBe(
    false,
  );
  expect(
    shouldRefreshMethodComparison(catalog, 'ring', '2026-11-10T00:05:00.000Z'),
  ).toBe(true);
  expect(shouldRefreshMethodComparison(null, 'ring', publishedAt)).toBe(true);
});
