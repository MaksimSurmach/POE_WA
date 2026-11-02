import { describe, expect, it } from 'vitest';

import { defaultCatalogFilters, filterCatalog } from './catalog.js';
import { catalogFixtures } from './mocks/catalog.js';

describe('cluster jewel catalog search', () => {
  it('searches recipe names, base names, summaries, and tags', () => {
    for (const search of ['physical', 'large cluster jewel', 'cluster']) {
      expect(
        filterCatalog(catalogFixtures, {
          ...defaultCatalogFilters,
          search,
        }).map(({ recipe }) => recipe.id),
      ).toContain('profitable-cluster');
    }
  });

  it('filters by the selected tag and returns no matches plainly', () => {
    expect(
      filterCatalog(catalogFixtures, {
        ...defaultCatalogFilters,
        tag: 'bow',
      }).map(({ recipe }) => recipe.id),
    ).toEqual(['no-listings-bow']);
    expect(
      filterCatalog(catalogFixtures, {
        ...defaultCatalogFilters,
        search: 'not a recipe',
      }),
    ).toEqual([]);
  });
});
