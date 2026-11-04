import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '@poe-worksmith/contracts';

import {
  defaultCatalogFilters,
  filterMarketTargets,
  formatMarginPercent,
  filterCatalog,
  readCatalogFilters,
  getPriceStatus,
  lowestAskInCurrency,
  marketTargetItemType,
  marketTargetTitle,
  type MarketListTarget,
} from './catalog.js';
import { catalogFixtures } from './mocks/catalog.js';

describe('catalog table ordering and numeric filters', () => {
  it('restores shared filters from the URL and rejects invalid sort options', () => {
    expect(
      readCatalogFilters(
        new URLSearchParams(
          'category=boots&search=slink&minProfit=0&minRoi=20&sort=roi&direction=desc&profitCurrency=divine',
        ),
      ),
    ).toMatchObject({
      category: 'boots',
      search: 'slink',
      minProfit: '0',
      minRoi: '20',
      sort: 'roi',
      direction: 'desc',
      profitCurrency: 'divine',
    });
    expect(
      readCatalogFilters(
        new URLSearchParams('sort=unknown&direction=up&profitCurrency=gold'),
      ),
    ).toMatchObject({
      sort: 'title',
      profitCurrency: 'chaos',
    });
    expect(readCatalogFilters(new URLSearchParams('direction=up')).direction).toBeUndefined();
  });
  const entries = [20, -5, null, 0].map((profit, index) => ({
    ...catalogFixtures[0]!,
    recipe: {
      ...catalogFixtures[0]!.recipe,
      id: `row-${index}`,
      title: `Item ${index}`,
      category: index % 2 ? 'boots' : 'wand',
    },
    evaluation: {
      ...catalogFixtures[0]!.evaluation,
      profit:
        profit === null ? null : { amount: profit, currency: 'chaos' as const },
      marginPercent: profit,
    },
  }));
  const ids = (values: CatalogEntry[]) =>
    values.map((entry) => entry.recipe.id);

  it.each(['profit', 'roi'] as const)(
    'sorts %s in both directions, with unknowns always last',
    (sort) => {
      expect(
        ids(
          filterCatalog(entries, {
            ...defaultCatalogFilters,
            sort,
            direction: 'desc',
          }),
        ),
      ).toEqual(['row-0', 'row-3', 'row-1', 'row-2']);
      expect(
        ids(
          filterCatalog(entries, {
            ...defaultCatalogFilters,
            sort,
            direction: 'asc',
          }),
        ),
      ).toEqual(['row-1', 'row-3', 'row-0', 'row-2']);
      expect(entries[0]!.recipe.id).toBe('row-0');
    },
  );

  it('combines name, class, tag and minimums, including zero', () => {
    expect(
      ids(
        filterCatalog(entries, {
          category: 'wand',
          search: ' ITEM ',
          minProfit: '0',
          minRoi: '0',
        }),
      ),
    ).toEqual(['row-0']);
    expect(
      ids(filterCatalog(entries, { ...defaultCatalogFilters, minProfit: '0' })),
    ).toEqual(['row-0', 'row-3']);
    expect(
      filterCatalog(entries, { ...defaultCatalogFilters, tag: 'missing-tag' }),
    ).toEqual([]);
    expect(
      filterCatalog(entries, { ...defaultCatalogFilters, minRoi: '21' }),
    ).toEqual([]);
    expect(
      filterCatalog(entries, {
        ...defaultCatalogFilters,
        minProfit: ' ',
        minRoi: 'invalid',
      }),
    ).toHaveLength(4);
  });

  it('sorts names and classes in both directions with deterministic ties', () => {
    expect(
      ids(
        filterCatalog(entries, {
          ...defaultCatalogFilters,
          sort: 'title',
          direction: 'desc',
        }),
      ),
    ).toEqual(['row-3', 'row-2', 'row-1', 'row-0']);
    expect(
      ids(
        filterCatalog(entries, {
          ...defaultCatalogFilters,
          sort: 'category',
          direction: 'asc',
        }),
      ),
    ).toEqual(['row-1', 'row-3', 'row-0', 'row-2']);
    expect(
      ids(
        filterCatalog(entries, {
          ...defaultCatalogFilters,
          sort: 'category',
          direction: 'desc',
        }),
      ),
    ).toEqual(['row-0', 'row-2', 'row-1', 'row-3']);
  });

  it('groups profit by its own currency even without cost, and filters only the chosen currency', () => {
    const mixed = entries.slice(0, 2).map((entry, index) => ({
      ...entry,
      evaluation: {
        ...entry.evaluation,
        expectedCraftCost: null,
        profit: {
          amount: index ? 50 : 1,
          currency: index ? ('chaos' as const) : ('divine' as const),
        },
      },
    }));
    expect(
      ids(filterCatalog(mixed, { ...defaultCatalogFilters, sort: 'profit' })),
    ).toEqual(['row-1', 'row-0']);
    expect(
      ids(
        filterCatalog(mixed, {
          ...defaultCatalogFilters,
          minProfit: '0',
          profitCurrency: 'divine',
        }),
      ),
    ).toEqual(['row-0']);
  });
});

describe('recipe catalog search and item type filters', () => {
  it('keeps lowest asks comparable by currency', () => {
    const snapshot = catalogFixtures[0]!.snapshot!;
    const listings = [
      {
        ...snapshot.listings[0]!,
        price: { amount: 2, currency: 'divine' as const },
      },
      {
        ...snapshot.listings[1]!,
        price: { amount: 30, currency: 'chaos' as const },
      },
      {
        ...snapshot.listings[2]!,
        price: { amount: 12, currency: 'chaos' as const },
      },
    ];

    expect(
      lowestAskInCurrency({ ...snapshot, listings }, 'chaos')?.price.amount,
    ).toBe(12);
    expect(
      lowestAskInCurrency({ ...snapshot, listings }, 'divine')?.price.amount,
    ).toBe(2);
    expect(
      lowestAskInCurrency({ ...snapshot, listings }, null),
    ).toBeUndefined();
  });

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

  it('restores starter market targets with item-type filtering and English titles', () => {
    const targets: MarketListTarget[] = [
      {
        name: 'Toxic Rain — колчан',
        slot: 'Колчан',
        baseTypes: ['Broadhead Arrow Quiver'],
        builds: ['Toxic Rain Pathfinder'],
        sources: [],
      },
      {
        name: 'Winter Orb — перчатки',
        slot: 'Перчатки',
        baseTypes: ['Warlock Gloves'],
        builds: ['Winter Orb Occultist'],
        sources: [],
      },
    ];

    expect(marketTargetItemType('Колчан')).toBe('quiver');
    expect(marketTargetItemType('Жезл')).toBe('weapon');
    expect(
      [
        'Пояс',
        'Ботинки',
        'Кольцо',
        'Щит',
        'Самоцвет',
        'Кластерный самоцвет',
      ].map(marketTargetItemType),
    ).toEqual(['belt', 'boots', 'ring', 'shield', 'jewel', 'cluster-jewel']);
    expect(marketTargetTitle(targets[0]!)).toBe('Broadhead Arrow Quiver');
    expect(
      filterMarketTargets(targets, {
        ...defaultCatalogFilters,
        category: 'quiver',
      }),
    ).toEqual([targets[0]]);
    expect(
      filterMarketTargets(targets, {
        ...defaultCatalogFilters,
        search: 'winter orb',
      }),
    ).toEqual([targets[1]]);
    expect(
      filterMarketTargets(targets, {
        ...defaultCatalogFilters,
        search: 'occultist',
      }),
    ).toEqual([targets[1]]);
  });
});
