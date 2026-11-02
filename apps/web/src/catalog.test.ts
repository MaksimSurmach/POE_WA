import { describe, expect, it } from 'vitest';

import {
  defaultCatalogFilters,
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

  it('reports price freshness from evaluation status and refresh age', () => {
    const now = Date.parse('2026-11-02T10:00:00.000Z');
    expect(getPriceStatus('success', '2026-11-02T06:00:00.000Z', now)).toBe(
      'Current',
    );
    expect(getPriceStatus('success', '2026-11-02T05:00:00.000Z', now)).toBe(
      'Outdated',
    );
    expect(getPriceStatus('stale', '2026-11-02T09:30:00.000Z', now)).toBe(
      'Outdated',
    );
    expect(getPriceStatus('partial', null, now)).toBe('Partial');
    expect(getPriceStatus('loading', null, now)).toBe('Updating');
    expect(getPriceStatus('error', null, now)).toBe('Unavailable');
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
