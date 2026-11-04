import { describe, expect, it } from 'vitest';
import { syntheticOutcomeInput } from '@poe-worksmith/domain/fixtures';
import {
  craftModelSaveInputSchema,
  craftRiskCreateInputSchema,
} from './craftAnalysis.js';

const id = '00000000-0000-4000-8000-000000000001';
describe('craft analysis request boundaries', () => {
  it('preserves explicit unknown probabilities rather than silently completing a distribution', () => {
    const analysis = syntheticOutcomeInput();
    analysis.model.stages[0]!.outcomes[0]!.probability = {
      value: null,
      provenance: null,
    };
    const input = craftModelSaveInputSchema.parse({
      recipeId: 'recipe',
      recipeHash: 'revision',
      league: analysis.league,
      expectedRevision: null,
      idempotencyKey: id,
      model: analysis.model,
      currency: 'chaos',
      prices: analysis.prices,
      valuations: analysis.valuations,
    });
    expect(input.model.stages[0]!.outcomes[0]!.probability.value).toBeNull();
    expect(input.prices.base?.amount).toBe('10');
    expect(() =>
      craftModelSaveInputSchema.parse({ ...input, expectedRevision: -1 }),
    ).toThrow();
  });
  it('cannot replace server-resolved market evidence inside a risk job request', () => {
    const input = {
      recipeId: 'recipe',
      recipeHash: 'revision',
      league: 'Synthetic League',
      modelId: id,
      idempotencyKey: id,
      simulation: {
        objective: { kind: 'attempts', count: 10 },
        seed: 'synthetic',
        budget: '100',
      },
    };
    expect(craftRiskCreateInputSchema.parse(input).simulation.trials).toBe(
      1000,
    );
    expect(() =>
      craftRiskCreateInputSchema.parse({
        ...input,
        simulation: { ...input.simulation, analysis: syntheticOutcomeInput() },
      }),
    ).toThrow();
    expect(() =>
      craftRiskCreateInputSchema.parse({
        ...input,
        simulation: { ...input.simulation, trials: 1000000 },
      }),
    ).toThrow();
  });
});
