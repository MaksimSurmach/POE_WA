import { describe, expect, it } from 'vitest';
import {
  initialPlan,
  planLine,
  planMaterials,
  readPlan,
} from './materialPlanModel.js';
import { profitableRecipeDetail } from './mocks/recipeDetails.js';

describe('shared budget and material plan', () => {
  it('keeps quantity and manual prices through a persisted draft without creating ledger events', () => {
    const materials = planMaterials(profitableRecipeDetail);
    const draft = initialPlan(materials);
    draft.count = '3';
    draft.rows.$base = { needed: '2', owned: '1', price: '0.1' };
    const resumed = readPlan(JSON.stringify(draft), initialPlan(materials));
    expect(resumed).toEqual(draft);
    expect(planLine(resumed.rows.$base!, resumed.count)).toEqual({
      needed: 6,
      buy: 5,
      cost: '0.5',
    });
    expect(Object.keys(resumed)).toEqual(['count', 'rows']);
  });
  it('preserves unknown quantities and prices, exact zero and integer trailing zeroes', () => {
    expect(
      initialPlan([
        { id: 'x', name: 'x', quantity: 100, price: 10, currency: 'chaos' },
      ]).rows.x,
    ).toEqual({ needed: '100', price: '10', owned: '0' });
    expect(planLine({ needed: '', owned: '0', price: '2' }, '1')).toBeNull();
    expect(
      planLine({ needed: '1', owned: '0', price: '' }, '1')?.cost,
    ).toBeNull();
    expect(planLine({ needed: '1', owned: '1', price: '' }, '1')).toEqual({
      needed: 1,
      buy: 0,
      cost: '0',
    });
    expect(planLine({ needed: '1', owned: '0', price: '0' }, '1')?.cost).toBe(
      '0',
    );
  });
  it.each(['', '0', '-1', '1.5', '1001', 'Infinity', 'NaN'])(
    'rejects invalid item count %s',
    (count) => {
      expect(
        planLine({ needed: '1', owned: '0', price: '1' }, count),
      ).toBeNull();
    },
  );
  it('does not infer execution counts from incomplete method evidence', () => {
    const detail = structuredClone(profitableRecipeDetail);
    detail.method.expectedExecutions = [];
    detail.method.expectedBases = null;
    detail.method.baseCost = null;
    const materials = planMaterials(detail);
    expect(materials[0]?.quantity).toBeNull();
    expect(materials[0]?.price).toBeNull();
    expect(materials.slice(1).every((row) => row.quantity === null)).toBe(true);
    const fallback = initialPlan(materials);
    for (const bad of [
      'invalid json',
      '{}',
      '{"count":"1","rows":null}',
      '{"count":"1","rows":{"$base":0}}',
    ])
      expect(readPlan(bad, fallback)).toEqual(fallback);
  });
});
