import { describe, expect, it } from 'vitest';

import {
  defaultCatalogFilters,
  formatMarginPercent,
  filterCatalog,
  getPriceStatus,
} from './catalog.js';
import { catalogFixtures } from './mocks/catalog.js';

describe('recipe catalog search and item type filters', () => {
  it('shows every item type and filters by category', () => {
    expect(
      new Set(
        filterCatalog(catalogFixtures, defaultCatalogFilters).map(
          ({ recipe }) => recipe.category,
        ),
      ),
    ).toEqual(
      new Set(['amulet', 'boots', 'cluster-jewel', 'gloves', 'ring', 'weapon']),
    );
    expect(
      filterCatalog(catalogFixtures, {
        ...defaultCatalogFilters,
        category: 'ring',
      }).map(({ recipe }) => recipe.id),
    ).toEqual(['low-margin-ring']);
  });

  it('reports price freshness from the server evaluation status', () => {
    expect(getPriceStatus('success')).toBe('Updated');
    expect(getPriceStatus('stale')).toBe('Outdated');
    expect(getPriceStatus('partial')).toBe('Partial');
    expect(getPriceStatus('loading')).toBe('Updating');
    expect(getPriceStatus('error')).toBe('Unavailable');
  });

  it('rounds ROI percentages without displaying negative zero', () => {
    expect(formatMarginPercent(33.3333)).toBe('33.3%');
    expect(formatMarginPercent(50)).toBe('50.0%');
    expect(formatMarginPercent(-0.04)).toBe('0.0%');
  });

  it('searches item names and summaries without using hidden recipe tags', () => {
    expect(
      filterCatalog(catalogFixtures, {
        ...defaultCatalogFilters,
        category: 'cluster-jewel',
        search: 'physical',
      }).map(({ recipe }) => recipe.id),
    ).toContain('profitable-cluster');
    expect(
      filterCatalog(catalogFixtures, {
        ...defaultCatalogFilters,
        search: 'not a recipe',
      }),
    ).toEqual([]);
  });
});
