import type {
  Price,
  TrendChange,
  TrendOverviewEntry,
  TrendSummary,
} from '@poe-worksmith/contracts';
import {
  compareExpectedCostWithAsk,
  type CraftFamily,
} from '@poe-worksmith/domain';
import {
  itemClassLabel,
  type RecipeLibraryOutput,
} from './recipeLibraryModel.js';

export type MarketGroup =
  'item-class' | 'craft-method' | 'price-range' | 'listing-activity';
export type MarketColor = 'price-change' | 'cost-spread' | 'listing-activity';
export type MarketSize = 'captured-listings' | 'equal' | 'asking-price';
export interface MarketRow {
  output: RecipeLibraryOutput;
  summary: TrendSummary | null;
  change: TrendChange | null;
  spread: Price | null;
  marginPercent: number | null;
  captured: number | null;
  sellers: number | null;
  exits: number | null;
}

// The caller selects the overview's league/window; sibling series are never summed.
export function enrichMarketOutputs(
  outputs: RecipeLibraryOutput[],
  trendEntries: readonly TrendOverviewEntry[] = [],
): MarketRow[] {
  const trends = new Map(
    trendEntries.map((entry) => [entry.recipeId, entry.summary]),
  );
  return outputs.map((output) => {
    const summary =
      output.recipeIds
        .flatMap((id) => {
          const value = trends.get(id);
          return value?.currency === output.currency ? [value] : [];
        })
        .sort(
          (a, b) =>
            b.windowObservations - a.windowObservations ||
            Date.parse(b.latestObservedAt) - Date.parse(a.latestObservedAt),
        )[0] ?? null;
    const comparison = compareExpectedCostWithAsk({
      expectedCost: output.cost
        ? { amount: String(output.cost.amount), currency: output.cost.currency }
        : null,
      ask: output.ask
        ? { amount: String(output.ask.amount), currency: output.ask.currency }
        : null,
    });
    return {
      output,
      summary,
      change: summary?.change ?? null,
      spread:
        comparison.profit === null
          ? null
          : { amount: Number(comparison.profit), currency: output.currency },
      marginPercent:
        comparison.marginPercent === null
          ? null
          : Number(comparison.marginPercent),
      captured: output.quoteEvidence?.captured ?? null,
      sellers: output.quoteEvidence?.sellers ?? null,
      exits: output.quoteEvidence?.exits ?? null,
    };
  });
}

const familyLabels: Record<CraftFamily, string> = {
  alteration: 'Alteration',
  chaos: 'Chaos Orb',
  essence: 'Essence',
  fossil: 'Fossil',
  harvest: 'Harvest',
  bench: 'Bench finish',
  other: 'Other',
};
export function marketMethodLabel(output: RecipeLibraryOutput) {
  if (!output.methods.length) return 'No recipe';
  const selected = output.cost
    ? output.methods.find(
        (entry) => entry.recipe.id === output.selectedRecipeId,
      )
    : null;
  const families = new Set(
    (selected ? [selected] : output.methods).map(
      (entry) => entry.recipe.craftFamilies?.[0] ?? 'other',
    ),
  );
  return families.size === 1
    ? familyLabels[[...families][0]!]
    : 'Multiple methods';
}

function groupLabel(row: MarketRow, group: MarketGroup) {
  if (group === 'item-class') return itemClassLabel(row.output.category);
  if (group === 'craft-method') return marketMethodLabel(row.output);
  if (group === 'listing-activity')
    return row.exits === null
      ? 'Activity not measured'
      : row.exits === 0
        ? 'No observed exits'
        : row.exits < 20
          ? '1–19 inferred exits'
          : '20+ inferred exits';
  const ask = row.output.ask;
  if (!ask) return 'No asking price';
  if (ask.currency !== 'chaos')
    return 'Chaos price range unavailable (divine ask)';
  return ask.amount < 10
    ? 'Under 10 c'
    : ask.amount < 50
      ? '10–<50 c'
      : ask.amount < 200
        ? '50–<200 c'
        : ask.amount < 1000
          ? '200–<1,000 c'
          : '1,000 c and above';
}
function sizeValue(row: MarketRow, size: MarketSize) {
  return size === 'equal'
    ? 1
    : size === 'captured-listings'
      ? row.captured
      : (row.output.ask?.amount ?? null);
}
function colorValue(row: MarketRow, color: MarketColor) {
  return color === 'price-change'
    ? (row.change?.percent ?? null)
    : color === 'cost-spread'
      ? (row.spread?.amount ?? null)
      : row.exits;
}
interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Weighted {
  value: number;
}

function layout<T extends Weighted>(
  items: T[],
  bounds: Bounds,
): Array<T & Bounds> {
  if (items.length < 2) return items.map((item) => ({ ...item, ...bounds }));
  const total = items.reduce((sum, item) => sum + item.value, 0);
  let index = 1;
  let first = items[0]!.value;
  while (
    index < items.length - 1 &&
    Math.abs(first + items[index]!.value - total / 2) <
      Math.abs(first - total / 2)
  )
    first += items[index++]!.value;
  const ratio = first / total;
  const horizontal = bounds.width >= bounds.height;
  const a = horizontal
    ? { ...bounds, width: bounds.width * ratio }
    : { ...bounds, height: bounds.height * ratio };
  const b = horizontal
    ? { ...bounds, x: bounds.x + a.width, width: bounds.width - a.width }
    : { ...bounds, y: bounds.y + a.height, height: bounds.height - a.height };
  return [
    ...layout(items.slice(0, index), a),
    ...layout(items.slice(index), b),
  ];
}

export function compositionGroups(
  rows: MarketRow[],
  group: MarketGroup,
  color: MarketColor,
  size: MarketSize,
) {
  const unsized: MarketRow[] = [];
  const grouped = new Map<
    string,
    Array<{ row: MarketRow; value: number; colorValue: number | null }>
  >();
  for (const row of rows) {
    const value = sizeValue(row, size);
    if (value === null || !Number.isFinite(value) || value <= 0) {
      unsized.push(row);
      continue;
    }
    const label = groupLabel(row, group);
    const tile = { row, value, colorValue: colorValue(row, color) };
    const bucket = grouped.get(label);
    if (bucket) bucket.push(tile);
    else grouped.set(label, [tile]);
  }
  const groups = [...grouped].map(([label, tiles]) => ({
    id: label,
    label,
    value: tiles.reduce((sum, tile) => sum + tile.value, 0),
    tiles,
  }));
  const bounds = { x: 0, y: 0, width: 1, height: 1 };
  return {
    groups: layout(
      groups.sort(
        (a, b) => b.value - a.value || a.label.localeCompare(b.label),
      ),
      bounds,
    ).map((item) => ({
      ...item,
      tiles: layout(
        item.tiles.sort(
          (a, b) =>
            b.value - a.value || a.row.output.id.localeCompare(b.row.output.id),
        ),
        bounds,
      ),
    })),
    unsized,
  };
}

export function marketRowsCsv(rows: readonly MarketRow[]) {
  const cell = (value: string | number | null) =>
    `"${(typeof value === 'string' ? value.replace(/^[=+@-]/, "'$&") : String(value ?? '')).replaceAll('"', '""')}"`;
  const data: Array<Array<string | number | null>> = [
    [
      'Item',
      'Craft method',
      'Lowest ask',
      'Currency',
      'Change percent',
      'Change from',
      'Change to',
      'Captured listings',
      'Craft cost',
      'Est craft margin',
      'Quote captured',
      'Cost coverage',
    ],
    ...rows.map((r) => [
      r.output.name,
      marketMethodLabel(r.output),
      r.output.ask?.amount ?? null,
      r.output.currency,
      r.change?.percent ?? null,
      r.change?.fromObservedAt ?? null,
      r.change?.toObservedAt ?? null,
      r.captured,
      r.output.cost?.amount ?? null,
      r.spread?.amount ?? null,
      r.output.quoteAt,
      `${r.output.coverage.estimated}/${r.output.coverage.total}`,
    ]),
  ];
  return data.map((row) => row.map(cell).join(',')).join('\r\n');
}
