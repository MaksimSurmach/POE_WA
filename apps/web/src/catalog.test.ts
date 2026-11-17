import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '@poe-worksmith/contracts';
import { formatMarginPercent, lowestAskInCurrency } from './catalog.js';
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

describe('shared quote and formatting helpers', () => {
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

  it('rounds ROI percentages without displaying negative zero', () => {
    expect(formatMarginPercent(33.3333)).toBe('33.3%');
    expect(formatMarginPercent(50)).toBe('50.0%');
    expect(formatMarginPercent(-0.04)).toBe('0.0%');
  });
});
