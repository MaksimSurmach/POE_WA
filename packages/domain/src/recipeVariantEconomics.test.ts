import { describe, expect, it } from 'vitest';

import {
  calculateVariantMaterialEconomics,
  expectedVariantMaterialUsage,
} from './recipeVariantEconomics.js';
import { validateRecipeV2 } from './recipeSchemaV2.js';

const recipe = validateRecipeV2({
  base: {
    baseId: 'large-cluster-jewel',
    itemLevel: 84,
    rarity: 'rare',
    state: { corrupted: false, fractured: false, synthesised: false },
    variant: { kind: 'none' },
  },
  category: 'cluster-jewel',
  content: { craftSteps: [] },
  craft: {
    method: { kind: 'harvest-reforge', tag: 'physical' },
    startingMods: [],
    variants: [
      {
        id: 'staged',
        name: 'Staged craft',
        steps: [
          {
            action: 'Roll',
            continueWhen: 'Continue',
            failureAction: 'Restart',
            id: 'roll',
            materials: [{ itemId: 'fossil', quantity: 2 }],
            title: 'Roll',
          },
          {
            action: 'Finish',
            continueWhen: 'Done',
            failureAction: 'Keep base',
            id: 'finish',
            materials: [{ itemId: 'fossil', quantity: 1 }],
            title: 'Finish',
          },
        ],
        expectedExecutions: [
          {
            count: 3,
            evidence: {
              method: 'Manual simulation',
              patch: '3.26',
              url: 'https://example.com/craft',
              verifiedAt: '2026-11-02',
            },
            stepId: 'roll',
          },
          {
            count: 1,
            evidence: {
              method: 'Manual simulation',
              patch: '3.26',
              url: 'https://example.com/craft',
              verifiedAt: '2026-11-02',
            },
            stepId: 'finish',
          },
        ],
      },
    ],
  },
  gameDataVersion: '3.26.0',
  id: 'staged-cluster',
  schemaVersion: 2,
  target: { allOf: [], anyOf: [], minimumMatched: null },
  title: 'Staged Cluster',
});

describe('expected variant material usage', () => {
  it('sums materials using per-step entered executions', () => {
    expect(expectedVariantMaterialUsage(recipe.craft.variants![0]!)).toEqual({
      fossil: 7,
    });
  });

  it('returns unavailable when a material stage lacks expected execution evidence', () => {
    const variant = {
      ...recipe.craft.variants![0]!,
      expectedExecutions: recipe.craft.variants![0]!.expectedExecutions!.slice(
        0,
        1,
      ),
    };
    expect(expectedVariantMaterialUsage(variant)).toBeNull();
  });

  it('keeps a known unit price when per-attempt quantity is unknown', () => {
    const source = recipe.craft.variants![0]!;
    const variant = {
      ...source,
      steps: [
        source.steps[0]!,
        {
          ...source.steps[1]!,
          materials: [{ itemId: 'fossil', quantity: null }],
        },
      ],
    };
    expect(expectedVariantMaterialUsage(variant)).toBeNull();
    const economics = calculateVariantMaterialEconomics({
      currency: 'chaos',
      materialPrices: { fossil: { amount: '0.5', currency: 'chaos' } },
      variant,
    });
    expect(economics.expectedCost).toBeNull();
    expect(economics.steps[1]?.materials[0]).toEqual({
      costPerAttempt: null,
      itemId: 'fossil',
      quantityPerAttempt: null,
      unitPrice: { amount: '0.5', currency: 'chaos' },
    });
  });

  it('prices a known single attempt without expected execution evidence', () => {
    const source = recipe.craft.variants![0]!;
    const variant = {
      ...source,
      expectedExecutions: undefined,
      steps: [source.steps[0]!],
    };
    expect(
      calculateVariantMaterialEconomics({
        currency: 'chaos',
        materialPrices: { fossil: { amount: '0.5', currency: 'chaos' } },
        variant,
      }),
    ).toMatchObject({
      expectedCost: null,
      materialsPerAttempt: { amount: '1', currency: 'chaos' },
    });
  });

  it('prices per-step materials without multiplying staged costs by inverse chance', () => {
    const variant = recipe.craft.variants![0]!;
    expect(
      calculateVariantMaterialEconomics({
        currency: 'chaos',
        materialPrices: { fossil: { amount: '0.5', currency: 'chaos' } },
        variant,
      }),
    ).toMatchObject({
      expectedCost: { amount: '3.5', currency: 'chaos' },
      materialsPerAttempt: null,
      steps: [
        { materials: [{ costPerAttempt: { amount: '1', currency: 'chaos' } }] },
        {
          materials: [{ costPerAttempt: { amount: '0.5', currency: 'chaos' } }],
        },
      ],
    });
  });
});
