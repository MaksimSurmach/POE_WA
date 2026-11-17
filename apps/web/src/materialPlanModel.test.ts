import { describe, expect, it } from 'vitest';
import {
  initialPlan,
  planLine,
  planMaterials,
  readPlan,
  refreshPlanPrices,
  planScope,
  planTsv,
} from './materialPlanModel.js';
import { profitableRecipeDetail } from './mocks/recipeDetails.js';

describe('shared budget and material plan', () => {
  it('keeps quantity and manual prices through a persisted draft without creating ledger events', () => {
    const materials = planMaterials(profitableRecipeDetail);
    const draft = initialPlan(materials);
    draft.count = '3';
    draft.rows.$base = {
      needed: '2',
      owned: '1',
      price: '0.1',
      currency: 'divine',
      origin: 'manual',
      capturedAt: null,
    };
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
        {
          id: 'x',
          name: 'x',
          quantity: 100,
          price: 10,
          currency: 'chaos',
          capturedAt: null,
        },
      ]).rows.x,
    ).toEqual({
      needed: '100',
      price: '10',
      owned: '0',
      currency: 'chaos',
      origin: 'market',
      capturedAt: null,
    });
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

it('preserves frozen price units when a quote changes currency, and refreshes prices without losing quantities', () => {
  const detail = structuredClone(profitableRecipeDetail);
  const first = planMaterials(detail);
  const draft = initialPlan(first);
  draft.count = '3';
  draft.rows.$base = {
    needed: '2',
    owned: '1',
    price: '5',
    currency: 'divine',
    origin: 'market',
    capturedAt: null,
  };
  const scope = planScope(detail, 'test');
  detail.method.baseCost = { amount: 40, currency: 'chaos' };
  expect(planScope(detail, 'test')).toBe(scope);
  const resumed = readPlan(
    JSON.stringify(draft),
    initialPlan(planMaterials(detail)),
  );
  expect(resumed.rows.$base!.currency).toBe('divine');
  expect(resumed.rows.$base!.price).toBe('5');
  const refreshed = refreshPlanPrices(resumed, planMaterials(detail));
  expect(refreshed.count).toBe('3');
  expect(refreshed.rows.$base).toEqual({
    needed: '2',
    owned: '1',
    price: '40',
    currency: 'chaos',
    origin: 'market',
    capturedAt: null,
  });
});

it('keeps unknown units unknown and preserves manual prices on refresh', () => {
  const rows = [
    {
      id: 'x',
      name: 'x',
      quantity: 1,
      price: null,
      currency: null,
      capturedAt: null,
    },
  ];
  const draft = initialPlan(rows);
  expect(draft.rows.x!.currency).toBeNull();
  draft.rows.x = {
    needed: '1',
    owned: '0',
    price: '5',
    currency: 'divine',
    origin: 'manual',
    capturedAt: null,
  };
  expect(
    refreshPlanPrices(draft, [{ ...rows[0]!, price: 200, currency: 'chaos' }])
      .rows.x,
  ).toEqual(draft.rows.x);
  expect(
    readPlan(
      JSON.stringify({
        ...draft,
        rows: { x: { needed: '1', owned: '0', price: '5' } },
      }),
      initialPlan(rows),
    ),
  ).toEqual(initialPlan(rows));
});
it('exports plain TSV cells without spreadsheet formulas or extra rows', () => {
  expect(
    planTsv([['=cmd', '+item', '-item', '@item', 'Имя\tматериала\n', '1.25']]),
  ).toBe("'=cmd\t'+item\t'-item\t'@item\tИмя материала \t1.25");
});

it('fills an untouched unknown price when a quote becomes available', () => {
  const missing = [
    {
      id: 'x',
      name: 'x',
      quantity: 1,
      price: null,
      currency: null,
      capturedAt: null,
    },
  ];
  const draft = initialPlan(missing);
  expect(draft.rows.x!.origin).toBe('market');
  const next = refreshPlanPrices(draft, [
    {
      ...missing[0]!,
      price: 5,
      currency: 'divine',
      capturedAt: '2026-11-17T10:00:00Z',
    },
  ]);
  expect(next.rows.x).toEqual({
    needed: '1',
    owned: '0',
    price: '5',
    currency: 'divine',
    origin: 'market',
    capturedAt: '2026-11-17T10:00:00Z',
  });
});
