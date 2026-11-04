import { describe, expect, it } from 'vitest';
import { canonicalRecipeFixture, fixtureRecipe } from './fixtures/recipes.js';
import { validateRecipeDocument } from './recipeSchema.js';
import { syntheticOutcomeInput } from './fixtures/outcomes.js';
import {
  calculateMethodMaterialEconomics,
  compareCraftWithAsk,
  expectedMethodMaterialUsage,
} from './recipeEconomics.js';

const price = { amount: '2', currency: 'chaos' };
describe('single-method recipes', () => {
  it('binds an embedded exact-target success to the recipe output', () => {
    const model = syntheticOutcomeInput().model;
    model.stages[0]!.outcomes[0]!.matching = {
      kind: 'exact-target',
      targetSignature: 'another-output',
    };
    const input = {
      ...canonicalRecipeFixture,
      craft: { ...canonicalRecipeFixture.craft, outcomeModel: model },
    };
    expect(() => validateRecipeDocument(input)).toThrow(/outcome target/i);
    model.stages[0]!.outcomes[0]!.matching.targetSignature =
      canonicalRecipeFixture.targetSignature;
    expect(validateRecipeDocument(input).craft.outcomeModel).toBeDefined();
  });
  it('shares the output signature across methods while keeping independent costs', () => {
    const first = canonicalRecipeFixture;
    const second = fixtureRecipe({
      ...first,
      id: 'another-method',
      craft: {
        ...first.craft,
        id: 'currency',
        method: { kind: 'currency', currency: 'chaos-orb' },
        expectedExecutions: first.craft.expectedExecutions?.map((e) => ({
          ...e,
          count: 12,
        })),
      },
    });
    expect(second.targetSignature).toBe(first.targetSignature);
    const cost = (recipe: typeof first) =>
      calculateMethodMaterialEconomics({
        currency: 'chaos',
        materialPrices: { 'primal-crystallised-lifeforce': price },
        method: recipe.craft,
      }).expectedCost?.amount;
    expect(cost(first)).toBe('1800');
    expect(cost(second)).toBe('3600');
    const different = fixtureRecipe({
      ...first,
      target: {
        ...first.target,
        prefixes: [{ kind: 'explicit', modId: 'different-mod' }],
      },
    });
    expect(different.targetSignature).not.toBe(first.targetSignature);
  });
  it('rejects legacy shapes, alternatives, changed signatures and dangling execution counts', () => {
    expect(() => validateRecipeDocument({ schemaVersion: 1 })).toThrow();
    expect(() =>
      validateRecipeDocument({
        ...canonicalRecipeFixture,
        craft: { ...canonicalRecipeFixture.craft, variants: [] },
      }),
    ).toThrow();
    expect(() =>
      validateRecipeDocument({
        ...canonicalRecipeFixture,
        base: { ...canonicalRecipeFixture.base, itemLevel: 1 },
      }),
    ).toThrow(/signature/);
    expect(() =>
      fixtureRecipe({
        ...canonicalRecipeFixture,
        craft: {
          ...canonicalRecipeFixture.craft,
          expectedExecutions: [
            {
              ...canonicalRecipeFixture.craft.expectedExecutions?.[0],
              stepId: 'missing',
            },
          ],
        },
      }),
    ).toThrow(/Unknown step/);
  });
  it('rejects duplicate modifiers across affix groups and evidence from another patch', () => {
    expect(() =>
      fixtureRecipe({
        ...canonicalRecipeFixture,
        target: {
          prefixes: [{ kind: 'explicit', modId: 'duplicate' }],
          suffixes: [{ kind: 'explicit', modId: 'duplicate' }],
          implicits: [],
          other: [],
        },
      }),
    ).toThrow(/Duplicate/);
    expect(() =>
      fixtureRecipe({ ...canonicalRecipeFixture, patch: 'another-patch' }),
    ).toThrow(/evidence patch/);
  });
  it('keeps per-attempt costs but withholds an unknown multistage estimate', () => {
    const method = {
      ...canonicalRecipeFixture.craft,
      expectedExecutions: undefined,
    };
    const result = calculateMethodMaterialEconomics({
      currency: 'chaos',
      materialPrices: { 'primal-crystallised-lifeforce': price },
      method,
    });
    expect(result.expectedCost).toBeNull();
    expect(result.materialsPerAttempt?.amount).toBe('300');
    expect(
      compareCraftWithAsk({
        basePrice: price,
        materialCost: null,
        expectedBases: 1,
        ask: price,
        currency: 'chaos',
      }).profit,
    ).toBeNull();
  });
  it('sums reroll and finishing executions independently per finished item', () => {
    const source = canonicalRecipeFixture.craft;
    const step = source.steps[0]!;
    const evidence = source.expectedExecutions![0]!.evidence;
    const result = calculateMethodMaterialEconomics({
      currency: 'chaos',
      materialPrices: {
        reroll: { amount: '2', currency: 'chaos' },
        finish: { amount: '5', currency: 'chaos' },
      },
      method: {
        ...source,
        steps: [
          {
            ...step,
            id: 'roll',
            materials: [{ itemId: 'reroll', quantity: 2 }],
          },
          {
            ...step,
            id: 'finish',
            materials: [{ itemId: 'finish', quantity: 1 }],
          },
        ],
        expectedExecutions: [
          { stepId: 'roll', count: 10, evidence },
          { stepId: 'finish', count: 2, evidence },
        ],
      },
    });
    expect(result.expectedCost).toEqual({ amount: '50', currency: 'chaos' });
  });
  it('accumulates the same material across rerolls and finishing for price and stock', () => {
    const source = canonicalRecipeFixture.craft;
    const step = source.steps[0]!;
    const evidence = source.expectedExecutions![0]!.evidence;
    const method = {
      ...source,
      steps: [
        { ...step, id: 'roll', materials: [{ itemId: 'shared', quantity: 2 }] },
        {
          ...step,
          id: 'finish',
          materials: [{ itemId: 'shared', quantity: 1 }],
        },
      ],
      expectedExecutions: [
        { stepId: 'roll', count: 3, evidence },
        { stepId: 'finish', count: 4, evidence },
      ],
    };
    expect(expectedMethodMaterialUsage(method)).toEqual({ shared: 10 });
    expect(
      calculateMethodMaterialEconomics({
        currency: 'chaos',
        materialPrices: { shared: price },
        method,
      }).expectedCost,
    ).toEqual({ amount: '20', currency: 'chaos' });
  });

  it.each([
    {
      name: 'missing paid finish count',
      materials: [{ itemId: 'finish', quantity: 1 }],
      count: undefined,
      expected: null,
    },
    {
      name: 'unknown finish quantity',
      materials: [{ itemId: 'finish', quantity: null }],
      count: 1,
      expected: null,
    },
    {
      name: 'free instruction without a count',
      materials: [],
      count: undefined,
      expected: '1800',
    },
  ])(
    'handles $name without silently underpricing the craft',
    ({ materials, count, expected }) => {
      const source = canonicalRecipeFixture.craft;
      const method = {
        ...source,
        steps: [
          ...source.steps,
          { ...source.steps[0]!, id: 'finish', materials },
        ],
        expectedExecutions: [
          ...source.expectedExecutions!,
          ...(count === undefined
            ? []
            : [
                {
                  stepId: 'finish',
                  count,
                  evidence: source.expectedExecutions![0]!.evidence,
                },
              ]),
        ],
      };
      const result = calculateMethodMaterialEconomics({
        currency: 'chaos',
        materialPrices: {
          'primal-crystallised-lifeforce': price,
          finish: price,
        },
        method,
      });
      expect(result.expectedCost).toEqual(
        expected === null ? null : { amount: expected, currency: 'chaos' },
      );
      expect(expectedMethodMaterialUsage(method)).toEqual(
        expected === null ? null : { 'primal-crystallised-lifeforce': 900 },
      );
    },
  );

  it('includes replacement bases, preserves losses and rejects cross-currency ROI', () => {
    const input = {
      basePrice: price,
      materialCost: { amount: '10', currency: 'chaos' },
      expectedBases: 3,
      ask: { amount: '8', currency: 'chaos' },
      currency: 'chaos',
    };
    expect(compareCraftWithAsk(input)).toEqual({
      expectedCraftCost: '16',
      profit: '-8',
      marginPercent: '-50',
    });
    expect(
      compareCraftWithAsk({
        ...input,
        ask: { amount: '8', currency: 'divine' },
      }).profit,
    ).toBeNull();
  });
  it('returns 20 percent ROI for a 10 divine craft compared with a 12 divine ask', () => {
    expect(
      compareCraftWithAsk({
        basePrice: { amount: '1', currency: 'divine' },
        materialCost: { amount: '9', currency: 'divine' },
        expectedBases: 1,
        ask: { amount: '12', currency: 'divine' },
        currency: 'divine',
      }),
    ).toEqual({ expectedCraftCost: '10', profit: '2', marginPercent: '20' });
  });
});
