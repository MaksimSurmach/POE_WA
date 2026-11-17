import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '@poe-worksmith/contracts';

import {
  defaultCatalogFilters,
  filterMarketTargets,
  formatMarginPercent,
  filterCatalog,
  groupByTarget,
  readCatalogFilters,
  getPriceStatus,
  lowestAskInCurrency,
  marketTargetItemType,
  marketTargetTitle,
  type MarketListTarget,
} from './catalog.js';
import { catalogFixtures } from './mocks/catalog.js';
import { selectRecipeLibrary, libraryQuote } from './recipeLibraryModel.js';
import { catalogEntrySchema } from '@poe-worksmith/contracts';
import archive from './mocks/category-library-archive.json';

describe('approved 17 November archive (historical, never live product data)', () => {
  const entries = archive.entries.map((e) => catalogEntrySchema.parse(e));
  it('keeps quote price, timestamp and freshness attached to the same source', () => {
    const entry = { ...catalogFixtures[0]!, readiness: entries[0]!.readiness };
    expect(libraryQuote(entry, 'chaos')).toMatchObject({
      price: { amount: 270 },
      at: '2026-11-17T15:08:45.878Z',
      stale: true,
    });
    expect(libraryQuote(entry, 'divine')).toMatchObject({
      price: { amount: 8 },
      evidence: { captured: 10, reported: 42, sellers: 8, exits: null },
      at: '2026-07-20T00:00:00.000Z',
      stale: null,
    });
  });
  it('retains 66 outputs, 72 routes and the complete global category/family counts', () => {
    const all = selectRecipeLibrary(entries);
    expect(all.total).toBe(66);
    expect(all.methodCount).toBe(72);
    expect(all.categories.map((c) => c.count)).toEqual([
      21, 6, 3, 4, 2, 2, 12, 9, 1, 2, 2, 2,
    ]);
    expect(
      selectRecipeLibrary(entries, { category: 'cluster-jewel' }),
    ).toMatchObject({ methodCount: 27 });
    const fossil = selectRecipeLibrary(entries, { family: 'fossil' });
    expect(fossil.outputs).toHaveLength(12);
    expect(fossil.methodCount).toBe(12);
    expect(fossil.categories).toEqual(all.categories);
    expect(fossil.families).toEqual(all.families);
    expect(
      selectRecipeLibrary(entries, { family: 'bench' }).outputs,
    ).toHaveLength(5);
    expect(
      all.outputs.find((o) =>
        o.recipeIds.includes(
          'small-cluster-armour-enduring-composure-2-passives',
        ),
      )?.quoteEvidence,
    ).toMatchObject({ captured: 100, reported: 840, sellers: 84, exits: null });
  });
  it('uses cost rather than profit, preserves Fettle total and keeps unpriced routes', () => {
    expect(
      selectRecipeLibrary(entries, { estimatesOnly: true }).outputs,
    ).toHaveLength(10);
    expect(
      selectRecipeLibrary(entries, { estimatesOnly: true, family: 'fossil' })
        .outputs,
    ).toHaveLength(0);
    const fettle = selectRecipeLibrary(entries, { search: 'fettle' }).outputs;
    expect(fettle).toHaveLength(1);
    expect(fettle[0]).toMatchObject({
      cost: { amount: 38.49179117 },
      coverage: { estimated: 1, total: 1 },
      ask: { amount: 100 },
    });
    const physical = selectRecipeLibrary(entries).outputs.find((o) =>
      o.recipeIds.includes('physical-large-cluster-chaos'),
    );
    expect(physical).toMatchObject({
      cost: null,
      coverage: { estimated: 0, total: 2 },
    });
    expect(
      selectRecipeLibrary(entries, { search: 'Furious Assault' }).outputs.some(
        (o) => o.id === physical?.id,
      ),
    ).toBe(true);
  });
});

describe('Category Library target selection', () => {
  const source = catalogFixtures[0]!;
  const route = (
    id: string,
    families: NonNullable<CatalogEntry['recipe']['craftFamilies']>,
    cost: number | null,
  ): CatalogEntry => ({
    ...source,
    recipe: { ...source.recipe, id, craftFamilies: families },
    evaluation: {
      ...source.evaluation,
      profit: null,
      expectedCraftCost:
        cost === null ? null : { amount: cost, currency: 'chaos' },
    },
  });
  const entries = [
    route('chaos', ['chaos'], 50),
    route('fossil-bench', ['fossil', 'bench'], 70),
    route('unknown', ['fossil'], null),
  ];
  it('groups exact signatures and filters routes before ranking costs, retaining unknown alternatives', () => {
    const all = selectRecipeLibrary(entries);
    expect(all.outputs).toHaveLength(1);
    expect(all.methodCount).toBe(3);
    expect(all.outputs[0]).toMatchObject({
      id: source.recipe.targetSignature,
      cost: { amount: 50 },
      selectedRecipeId: 'chaos',
      coverage: { total: 3, estimated: 2, unknown: 1 },
    });
    const fossil = selectRecipeLibrary(entries, { family: 'fossil' });
    expect(fossil.outputs[0]).toMatchObject({
      cost: { amount: 70 },
      selectedRecipeId: 'fossil-bench',
      coverage: { total: 2, estimated: 1, unknown: 1 },
    });
    expect(fossil.outputs[0]?.methods.map((e) => e.recipe.id)).toEqual([
      'fossil-bench',
      'unknown',
    ]);
    expect(fossil.categories).toEqual(all.categories);
    expect(fossil.families).toEqual(all.families);
    expect(selectRecipeLibrary(entries, { family: 'bench' }).methodCount).toBe(
      1,
    );
  });
  it('includes valid zero estimates without requiring profit, and excludes incompatible prices from ranking', () => {
    expect(
      selectRecipeLibrary([route('zero', ['chaos'], 0)], {
        estimatesOnly: true,
      }).outputs,
    ).toHaveLength(1);
    expect(
      selectRecipeLibrary([route('unknown', ['fossil'], null)], {
        estimatesOnly: true,
      }).outputs,
    ).toHaveLength(0);
    expect(
      selectRecipeLibrary(entries, { currency: 'divine', estimatesOnly: true })
        .outputs,
    ).toHaveLength(0);
  });
  it('keeps different signatures separate, sorts nulls last and accepts legacy favorite recipe IDs', () => {
    const other = {
      ...route('other', ['chaos'], null),
      recipe: {
        ...source.recipe,
        id: 'other',
        targetSignature: 'different',
        craftFamilies: ['chaos'] as const,
      },
    };
    expect(
      selectRecipeLibrary(
        [
          ...entries,
          { ...other, recipe: { ...other.recipe, craftFamilies: ['chaos'] } },
        ],
        { sort: 'cost' },
      ).outputs.map((o) => o.id),
    ).toEqual([source.recipe.targetSignature, 'different']);
    expect(
      selectRecipeLibrary(entries, {
        favoritesOnly: true,
        favoriteIds: ['fossil-bench'],
      }).outputs,
    ).toHaveLength(1);
    expect(
      selectRecipeLibrary(entries, {
        favoritesOnly: true,
        favoriteIds: ['monitor-only'],
      }).outputs,
    ).toHaveLength(0);
  });
});

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
      sort: 'profit',
      profitCurrency: 'chaos',
    });
    expect(
      readCatalogFilters(new URLSearchParams('direction=up')).direction,
    ).toBeUndefined();
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

  it('groups methods by exact target signature with the best valid profit first', () => {
    const withTarget = (index: number, targetSignature: string) => ({
      ...entries[index]!,
      recipe: { ...entries[index]!.recipe, targetSignature },
    });
    // Profits: row-0 = 20, row-1 = -5, row-2 = withheld, row-3 = 0.
    expect(
      groupByTarget([
        withTarget(2, 'target-a'),
        withTarget(1, 'target-b'),
        withTarget(3, 'target-a'),
        withTarget(0, 'target-a'),
      ]).map(ids),
    ).toEqual([['row-0', 'row-2', 'row-3'], ['row-1']]);
  });

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
    expect(getPriceStatus('success')).toBe('Обновлено');
    expect(getPriceStatus('stale')).toBe('Устарело');
    expect(getPriceStatus('partial')).toBe('Частично');
    expect(getPriceStatus('loading')).toBe('Обновляется');
    expect(getPriceStatus('error')).toBe('Недоступно');
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

it('reads the actual threshold currency from current or legacy context without losing an explicit chaos selection', () => {
  expect(
    readCatalogFilters(new URLSearchParams('currency=divine')).profitCurrency,
  ).toBe('divine');
  expect(
    readCatalogFilters(
      new URLSearchParams('currency=divine&profitCurrency=chaos'),
    ).profitCurrency,
  ).toBe('chaos');
  expect(
    readCatalogFilters(new URLSearchParams('view=screener&catalogView=priced'))
      .view,
  ).toBe('priced');
});
