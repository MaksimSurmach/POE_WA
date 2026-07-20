import { describe, expect, it } from 'vitest';

import {
  defaultCatalogFilters,
  filterAndSortCatalog,
  snapshotAgeSeconds,
} from './catalog.js';
import { catalogFixtures } from './mocks/catalog.js';

describe('catalog filtering and ranking', () => {
  it('filters every supported dimension and keeps no-results distinct', () => {
    expect(
      filterAndSortCatalog(catalogFixtures, {
        ...defaultCatalogFilters,
        category: 'weapon',
        method: 'fossil',
        status: 'partial',
        tag: 'bow',
      }).map(({ recipe }) => recipe.id),
    ).toEqual(['no-listings-bow']);
    expect(
      filterAndSortCatalog(catalogFixtures, {
        ...defaultCatalogFilters,
        budget: '2',
      }).every(({ recipe }) => recipe.minimumCapital.amount <= 2),
    ).toBe(true);
    expect(
      filterAndSortCatalog(catalogFixtures, {
        ...defaultCatalogFilters,
        search: 'not a recipe',
      }),
    ).toEqual([]);
  });

  it('sorts profit, capital, and freshness deterministically', () => {
    expect(
      filterAndSortCatalog(catalogFixtures, defaultCatalogFilters)[0]?.recipe
        .id,
    ).toBe('profitable-cluster');
    const capitalRanking = filterAndSortCatalog(catalogFixtures, {
      ...defaultCatalogFilters,
      sort: 'capital',
    });
    expect(capitalRanking[0]?.recipe.id).toBe('low-margin-ring');
    expect(capitalRanking.at(-1)?.recipe.id).toBe('invalid-recipe');
    expect(
      filterAndSortCatalog(catalogFixtures, {
        ...defaultCatalogFilters,
        sort: 'freshness',
      })[0]?.recipe.id,
    ).toBe('profitable-cluster');
    expect(
      snapshotAgeSeconds(catalogFixtures[0]!, '2026-07-20T00:02:00.000Z'),
    ).toBe(120);
  });
});
