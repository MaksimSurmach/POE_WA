import { describe, expect, it } from 'vitest';
import type {
  TrendOverviewEntry,
  TrendSummary,
} from '@poe-worksmith/contracts';
import { catalogFixtures } from './mocks/catalog.js';
import { selectRecipeLibrary } from './recipeLibraryModel.js';
import {
  compositionGroups,
  enrichMarketOutputs,
  marketMethodLabel,
  marketRowsCsv,
} from './marketHomeModel.js';

const output = selectRecipeLibrary(catalogFixtures, { currency: 'divine' })
  .outputs[0]!;
const summary = (fields: Partial<TrendSummary> = {}): TrendSummary => ({
  currency: 'divine',
  latestAsk: 8,
  latestObservedAt: '2026-11-18T00:00:00.000Z',
  latestComparableSellers: 4,
  latestCoverage: 'complete',
  latestCraftCost: null,
  latestCraftCostObservedAt: null,
  windowObservations: 5,
  windowFirstObservedAt: '2026-11-17T00:00:00.000Z',
  windowLastObservedAt: '2026-11-18T00:00:00.000Z',
  change: {
    from: 4,
    to: 8,
    absolute: 4,
    percent: 100,
    fromObservedAt: '2026-11-17T10:00:00.000Z',
    toObservedAt: '2026-11-18T00:00:00.000Z',
  },
  excludedCurrencies: [],
  ...fields,
});
const trend = (recipeId: string, value: TrendSummary): TrendOverviewEntry => ({
  recipeId,
  title: 'Source',
  category: 'ring',
  summary: value,
});

describe('Market composition uses the shared exact-output selection', () => {
  it('exports negative numeric observations without turning them into text and escapes unsafe labels', () => {
    const rows = enrichMarketOutputs(
      [
        {
          ...output,
          name: '=Unsafe,"label"',
          cost: { amount: 20, currency: 'divine' },
          ask: { amount: 8, currency: 'divine' },
        },
      ],
      [
        trend(
          output.recipeIds[0]!,
          summary({
            change: {
              from: 10,
              to: 8,
              absolute: -2,
              percent: -20,
              fromObservedAt: '2026-11-17T10:00:00.000Z',
              toObservedAt: '2026-11-18T00:00:00.000Z',
            },
          }),
        ),
      ],
    );
    const csv = marketRowsCsv(rows);
    expect(csv).toContain('"\'=Unsafe,""label"""');
    expect(csv).toContain('"-20"');
    expect(csv).toContain('"-12"');
    expect(csv).not.toContain("'-20");
    expect(csv).not.toContain("'-12");
  });

  it('uses approved chaos price boundaries without converting divine asks', () => {
    const cases = [
      [0, 'Under 10 c'],
      [9.99, 'Under 10 c'],
      [10, '10–<50 c'],
      [49.99, '10–<50 c'],
      [50, '50–<200 c'],
      [199.99, '50–<200 c'],
      [200, '200–<1,000 c'],
      [999.99, '200–<1,000 c'],
      [1000, '1,000 c and above'],
      [null, 'No asking price'],
    ] as const;
    for (const [amount, label] of cases) {
      const rows = enrichMarketOutputs([
        {
          ...output,
          currency: 'chaos',
          ask: amount === null ? null : { amount, currency: 'chaos' },
        },
      ]);
      expect(
        compositionGroups(rows, 'price-range', 'price-change', 'equal')
          .groups[0]?.label,
      ).toBe(label);
    }
    const divine = enrichMarketOutputs([
      { ...output, ask: { amount: 1, currency: 'divine' } },
    ]);
    expect(
      compositionGroups(divine, 'price-range', 'price-change', 'equal')
        .groups[0]?.label,
    ).toBe('Chaos price range unavailable (divine ask)');
  });
  it('uses measured activity boundaries while preserving zero and unknown', () => {
    const rows = enrichMarketOutputs([output]);
    for (const [exits, label] of [
      [null, 'Activity not measured'],
      [0, 'No observed exits'],
      [1, '1–19 inferred exits'],
      [19, '1–19 inferred exits'],
      [20, '20+ inferred exits'],
    ] as const) {
      rows[0]!.exits = exits;
      expect(
        compositionGroups(rows, 'listing-activity', 'listing-activity', 'equal')
          .groups[0]?.label,
      ).toBe(label);
      expect(
        compositionGroups(rows, 'listing-activity', 'listing-activity', 'equal')
          .groups[0]?.tiles[0]?.colorValue,
      ).toBe(exits);
    }
  });

  it('chooses one actual sibling series by observations then recency without summing', () => {
    const row = enrichMarketOutputs(
      [{ ...output, recipeIds: ['a', 'b', 'c'] }],
      [
        trend(
          'a',
          summary({
            windowObservations: 7,
            latestObservedAt: '2026-11-16T00:00:00.000Z',
          }),
        ),
        trend('b', summary({ windowObservations: 7 })),
        trend('c', summary({ windowObservations: 20, currency: 'chaos' })),
      ],
    )[0]!;
    expect(row.summary?.windowObservations).toBe(7);
    expect(row.summary?.latestObservedAt).toBe('2026-11-18T00:00:00.000Z');
    expect(row.change?.fromObservedAt).toBe('2026-11-17T10:00:00.000Z');
  });
  it('preserves decimal spread and null ROI for zero cost', () => {
    const base = {
      ...output,
      currency: 'chaos' as const,
      cost: { amount: 38.49179117, currency: 'chaos' as const },
      ask: { amount: 100, currency: 'chaos' as const },
    };
    expect(enrichMarketOutputs([base])[0]?.spread?.amount).toBe(61.50820883);
    expect(
      enrichMarketOutputs([{ ...base, cost: { ...base.cost, amount: 0 } }])[0]
        ?.marginPercent,
    ).toBeNull();
    expect(
      enrichMarketOutputs([
        { ...base, ask: { amount: 1, currency: 'divine' } },
      ])[0]?.spread,
    ).toBeNull();
  });
  it('does not replace missing live evidence with history or an estimated sale', () => {
    const row = enrichMarketOutputs(
      [{ ...output, quoteEvidence: null, ask: null, cost: null }],
      [trend(output.selectedRecipeId, summary())],
    )[0]!;
    expect(row.captured).toBeNull();
    expect(row.exits).toBeNull();
    expect(row.spread).toBeNull();
  });
  it('uses exclusive primary family groups rather than duplicating combined routes', () => {
    const essence = {
      ...output.methods[0]!,
      recipe: {
        ...output.methods[0]!.recipe,
        craftFamilies: ['essence', 'bench'] as ['essence', 'bench'],
      },
    };
    const fossil = {
      ...essence,
      recipe: {
        ...essence.recipe,
        id: 'fossil',
        craftFamilies: ['fossil'] as ['fossil'],
      },
    };
    expect(
      marketMethodLabel({ ...output, cost: null, methods: [essence] }),
    ).toBe('Essence');
    expect(
      marketMethodLabel({ ...output, cost: null, methods: [essence, fossil] }),
    ).toBe('Multiple methods');
    expect(
      marketMethodLabel({
        ...output,
        cost: output.cost,
        selectedRecipeId: 'fossil',
        methods: [essence, fossil],
      }),
    ).toBe('Fossil');
    expect(marketMethodLabel({ ...output, methods: [] })).toBe('No recipe');
  });
  it('keeps zero and unknown sizes outside proportional tiles without invented weights', () => {
    const rows = enrichMarketOutputs([
      output,
      { ...output, id: 'zero' },
      { ...output, id: 'unknown' },
    ]);
    rows[0]!.captured = 10;
    rows[1]!.captured = 0;
    rows[2]!.captured = null;
    const map = compositionGroups(
      rows,
      'item-class',
      'price-change',
      'captured-listings',
    );
    expect(map.groups.flatMap((g) => g.tiles)).toHaveLength(1);
    expect(map.unsized.map((r) => r.captured)).toEqual([0, null]);
    expect(map.groups[0]?.value).toBe(10);
    expect(map.groups[0]?.tiles[0]?.colorValue).toBeNull();
  });
  it('preserves proportional area globally and nonoverlapping bounded tiles', () => {
    const rows = enrichMarketOutputs([
      output,
      { ...output, id: 'second', category: 'helmet' },
      { ...output, id: 'third' },
    ]);
    rows.forEach((r, i) => {
      r.captured = [10, 20, 30][i]!;
    });
    const map = compositionGroups(
      rows,
      'item-class',
      'listing-activity',
      'captured-listings',
    );
    for (const group of map.groups)
      for (const tile of group.tiles) {
        expect(
          group.width * group.height * tile.width * tile.height,
        ).toBeCloseTo(tile.value / 60, 8);
        expect(tile.x).toBeGreaterThanOrEqual(0);
        expect(tile.y).toBeGreaterThanOrEqual(0);
        expect(tile.x + tile.width).toBeLessThanOrEqual(1.00000001);
        expect(tile.y + tile.height).toBeLessThanOrEqual(1.00000001);
      }
    expect(
      map.groups.reduce((sum, g) => sum + g.width * g.height, 0),
    ).toBeCloseTo(1, 8);
    const rectangles = map.groups.flatMap((g) =>
      g.tiles.map((t) => ({
        x: g.x + t.x * g.width,
        y: g.y + t.y * g.height,
        width: t.width * g.width,
        height: t.height * g.height,
      })),
    );
    for (let a = 0; a < rectangles.length; a++)
      for (let b = a + 1; b < rectangles.length; b++) {
        const left = rectangles[a]!;
        const right = rectangles[b]!;
        const overlapX =
          Math.min(left.x + left.width, right.x + right.width) -
          Math.max(left.x, right.x);
        const overlapY =
          Math.min(left.y + left.height, right.y + right.height) -
          Math.max(left.y, right.y);
        expect(Math.max(0, overlapX) * Math.max(0, overlapY)).toBeLessThan(
          1e-12,
        );
      }
  });
  it('equal size includes zero and unknown targets without changing their metrics', () => {
    const rows = enrichMarketOutputs([output, { ...output, id: 'unknown' }]);
    rows[0]!.captured = 0;
    rows[1]!.captured = null;
    const map = compositionGroups(
      rows,
      'listing-activity',
      'listing-activity',
      'equal',
    );
    expect(map.unsized).toHaveLength(0);
    expect(map.groups.flatMap((g) => g.tiles).map((t) => t.value)).toEqual([
      1, 1,
    ]);
    expect(rows.map((r) => r.captured)).toEqual([0, null]);
  });
});
