import type { RecipeDetailView } from '@poe-worksmith/contracts';
import { calculateCostScenario } from '@poe-worksmith/domain/economics';

export type PlanDraft = {
  count: string;
  rows: Record<string, { needed: string; owned: string; price: string }>;
};
export type PlanMaterial = {
  id: string;
  name: string;
  quantity: number | null;
  price: number | null;
  currency: string;
};
const textNumber = (value: number | null) =>
  value === null ? '' : value.toFixed(8).replace(/(?:\.0+|(\.\d*?)0+)$/, '$1');

export function planMaterials(detail: RecipeDetailView): PlanMaterial[] {
  const method = detail.method;
  const rows: PlanMaterial[] = [
    {
      id: '$base',
      name: detail.base.name,
      quantity: method.expectedBases,
      price: method.baseCost?.amount ?? null,
      currency: method.baseCost?.currency ?? 'chaos',
    },
  ];
  for (const step of method.steps) {
    const executions = method.expectedExecutions.find(
      (value) => value.stepId === step.id,
    )?.count;
    for (const material of step.materials) {
      const quantity =
        executions == null || material.quantityPerAttempt === null
          ? null
          : executions * material.quantityPerAttempt;
      const existing = rows.find((row) => row.id === material.itemId);
      if (existing) {
        existing.quantity =
          existing.quantity === null || quantity === null
            ? null
            : existing.quantity + quantity;
        if (
          existing.price !== material.unitPrice?.amount ||
          existing.currency !== material.unitPrice?.currency
        )
          existing.price = null;
      } else
        rows.push({
          id: material.itemId,
          name: material.name,
          quantity,
          price: material.unitPrice?.amount ?? null,
          currency:
            material.unitPrice?.currency ??
            method.baseCost?.currency ??
            'chaos',
        });
    }
  }
  return rows;
}

export function initialPlan(materials: PlanMaterial[]): PlanDraft {
  return {
    count: '1',
    rows: Object.fromEntries(
      materials.map((row) => [
        row.id,
        {
          needed: textNumber(row.quantity),
          owned: '0',
          price: textNumber(row.price),
        },
      ]),
    ),
  };
}

export function readPlan(raw: string | null, fallback: PlanDraft): PlanDraft {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (
      !value ||
      typeof value !== 'object' ||
      !('count' in value) ||
      typeof value.count !== 'string' ||
      !('rows' in value) ||
      !value.rows ||
      typeof value.rows !== 'object'
    )
      return fallback;
    const rows = value.rows as Record<string, unknown>;
    if (
      !Object.keys(fallback.rows).every((id) => {
        const row = rows[id];
        return (
          row &&
          typeof row === 'object' &&
          ['needed', 'owned', 'price'].every(
            (field) =>
              field in row &&
              typeof (row as Record<string, unknown>)[field] === 'string',
          )
        );
      })
    )
      return fallback;
    return {
      count: value.count,
      rows: Object.fromEntries(
        Object.keys(fallback.rows).map((id) => [
          id,
          rows[id] as PlanDraft['rows'][string],
        ]),
      ),
    };
  } catch {
    return fallback;
  }
}

export function planLine(row: PlanDraft['rows'][string], count: string) {
  const valid = (text: string) =>
    /^\d+(?:\.\d{1,8})?$/.test(text) && Number(text) <= 1e12;
  if (
    !valid(count) ||
    !Number.isInteger(Number(count)) ||
    Number(count) < 1 ||
    Number(count) > 1000 ||
    !valid(row.needed) ||
    !valid(row.owned)
  )
    return null;
  const needed = Number((Number(row.needed) * Number(count)).toFixed(8));
  const buy = Number(Math.max(0, needed - Number(row.owned)).toFixed(8));
  const result = calculateCostScenario({
    bases: '0',
    other: '0',
    sale: '',
    materials: [{ quantity: buy.toFixed(8), unitPrice: row.price }],
  });
  return { needed, buy, cost: result?.cost ?? null };
}

export function planScope(detail: RecipeDetailView, league: string) {
  return JSON.stringify([
    detail.recipe.id,
    detail.gameVersion,
    detail.method.id,
    league,
    planMaterials(detail).map(({ id, currency }) => [id, currency]),
  ]);
}
