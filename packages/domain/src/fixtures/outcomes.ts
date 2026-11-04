import {
  outcomeAnalysisInputSchema,
  type OutcomeAnalysisInput,
  type OutcomeProvenance,
  type MethodOutcome,
} from '../outcomeModel.js';

export const syntheticOutcomeSource: OutcomeProvenance = {
  kind: 'assumption',
  reference: 'synthetic:domain-golden-tests',
  recordedAt: '2026-11-04T00:00:00Z',
  notes:
    'Labelled synthetic test values; not market observations or game probabilities.',
};
export function syntheticOutcome(
  id: string,
  probability: string | null,
  targetSuccess = false,
  sellable = false,
): MethodOutcome {
  return {
    id,
    name: id,
    classification: targetSuccess
      ? 'target'
      : sellable
        ? 'salvage'
        : 'unusable',
    probability: {
      value: probability,
      provenance: probability === null ? null : syntheticOutcomeSource,
    },
    nextStageId: null,
    baseDisposition: 'consumed',
    targetSuccess,
    sellable,
    matching: { kind: 'manual', description: `Synthetic ${id}` },
    costs: [],
    credits: [],
    unknowns: [],
  };
}
export function syntheticOutcomeInput(): OutcomeAnalysisInput {
  return outcomeAnalysisInputSchema.parse({
    currency: 'chaos',
    league: 'Synthetic League',
    now: '2026-11-04T01:00:00Z',
    model: {
      version: 1,
      id: 'synthetic-outcome-method',
      startStageId: 'roll',
      initialCosts: [],
      unknowns: [],
      stages: [
        {
          id: 'roll',
          name: 'Synthetic one-roll method',
          exclusivity: { mode: 'disjoint', provenance: syntheticOutcomeSource },
          costs: [
            {
              kind: 'base',
              resourceId: 'base',
              quantity: '1',
              provenance: syntheticOutcomeSource,
            },
            {
              kind: 'material',
              resourceId: 'orb',
              quantity: '1',
              provenance: syntheticOutcomeSource,
            },
          ],
          outcomes: [
            syntheticOutcome('target', '0.2', true, true),
            syntheticOutcome('salvage', '0.3', false, true),
            syntheticOutcome('waste', '0.5'),
          ],
        },
      ],
    },
    prices: {
      base: {
        amount: '10',
        currency: 'chaos',
        provenance: syntheticOutcomeSource,
      },
      orb: {
        amount: '2',
        currency: 'chaos',
        provenance: syntheticOutcomeSource,
      },
    },
    valuations: {
      target: {
        min: '30',
        max: '30',
        currency: 'chaos',
        matching: { kind: 'manual', description: 'Synthetic target' },
        provenance: syntheticOutcomeSource,
      },
      salvage: {
        min: '5',
        max: '5',
        currency: 'chaos',
        matching: { kind: 'manual', description: 'Synthetic salvage' },
        provenance: syntheticOutcomeSource,
      },
    },
  });
}
export function syntheticGeometricInput(
  reusableBase = true,
): OutcomeAnalysisInput {
  const input = syntheticOutcomeInput();
  const stage = input.model.stages[0]!;
  if (reusableBase) input.model.initialCosts = [stage.costs.shift()!];
  stage.outcomes = [
    syntheticOutcome('target', '0.25', true, true),
    {
      ...syntheticOutcome('failure', '0.75'),
      baseDisposition: reusableBase ? 'retained' : 'consumed',
    },
  ];
  input.valuations.target = {
    ...input.valuations.target!,
    min: '100',
    max: '100',
  };
  delete input.valuations.salvage;
  return input;
}
