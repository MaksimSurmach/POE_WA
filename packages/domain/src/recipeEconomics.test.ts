import { describe, expect, it } from 'vitest';
import { canonicalRecipeFixture } from './fixtures/recipes.js';
import {
  calculateMethodMaterialEconomics,
  gradeSaleEvidence,
  singleItemCraftBudget,
} from './recipeEconomics.js';

describe('sale evidence grades', () => {
  const complete = {
    sellers: 5,
    coverage: 'complete' as const,
    sortedSampleComplete: false,
    oldestInputAgeMs: 60_000,
    freshnessWarningMs: 60_000,
    ignoredOutliers: 0,
  };

  it.each([
    ['five sellers with complete fresh evidence', {}, 'A', []],
    ['one seller with complete evidence', { sellers: 1 }, 'C', ['1 seller']],
    ['two sellers', { sellers: 2 }, 'B', ['2–4 sellers']],
    ['four sellers', { sellers: 4 }, 'B', ['2–4 sellers']],
    [
      'validated sorted sample',
      { coverage: 'partial', sortedSampleComplete: true },
      'B',
      ['sorted sample, not full coverage'],
    ],
    [
      'inputs past the warning age',
      { oldestInputAgeMs: 60_001 },
      'B',
      ['inputs older than warning age'],
    ],
    ['ignored outlier', { ignoredOutliers: 1 }, 'B', ['outlier ask ignored']],
    [
      'single seller with a warning-age input',
      { sellers: 1, oldestInputAgeMs: 60_001 },
      'C',
      ['1 seller', 'inputs older than warning age'],
    ],
  ] as const)('grades %s', (_label, input, grade, reasons) => {
    expect(gradeSaleEvidence({ ...complete, ...input })).toEqual({
      grade,
      reasons,
    });
  });
});

describe('one-item budgets for independent flask stages', () => {
  const source = canonicalRecipeFixture.craft;
  const [sampleStep] = source.steps;
  const [execution] = source.expectedExecutions!;
  const budgetModel = {
    kind: 'independent-repeat-until-success' as const,
    stepIds: ['roll', 'finish'],
    basis: 'Repeat each stage on the same item.',
  };
  const craft = {
    ...source,
    budgetModel,
    steps: [
      {
        ...sampleStep!,
        id: 'roll',
        materials: [{ itemId: 'orb-of-alteration', quantity: 1 }],
      },
      {
        ...sampleStep!,
        id: 'finish',
        materials: [{ itemId: 'enkindling-orb', quantity: 1 }],
      },
    ],
    expectedExecutions: budgetModel.stepIds.map((stepId) => ({
      ...execution!,
      stepId,
      count: 2,
    })),
  };
  const currency = 'chaos';
  const unitPrice = { amount: '1', currency };

  it('uses the quantiles of the sum of two geometric stage costs', () => {
    const method = {
      ...craft,
      steps: craft.steps.map((step) => ({
        ...step,
        success: { ...step.success!, probability: 0.5 },
      })),
      expectedExecutions: craft.expectedExecutions?.map((step) => ({
        ...step,
        count: 2,
      })),
    };
    const { steps } = calculateMethodMaterialEconomics({
      method,
      currency,
      materialPrices: {
        'orb-of-alteration': unitPrice,
        'enkindling-orb': unitPrice,
      },
    });
    const input = {
      currency,
      steps,
      expectedExecutions: method.expectedExecutions,
      expectedCraftCost: '14',
    };
    expect(
      singleItemCraftBudget({ ...input, budgetModel: method.budgetModel }),
    ).toEqual({ p50: '13', p90: '17', currency });
    expect(singleItemCraftBudget(input)).toBeNull();
  });

  it('keeps budgets unavailable when a stage has no material price', () => {
    const { steps } = calculateMethodMaterialEconomics({
      method: craft,
      currency,
      materialPrices: { 'orb-of-alteration': unitPrice },
    });
    expect(
      singleItemCraftBudget({
        currency,
        steps,
        expectedExecutions: craft.expectedExecutions,
        expectedCraftCost: '10000',
        budgetModel: craft.budgetModel,
      }),
    ).toBeNull();
  });
});
