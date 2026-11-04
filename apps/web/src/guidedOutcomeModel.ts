import {
  outcomeAnalysisInputSchema,
  type OutcomeAnalysisInput,
  type OutcomeProvenance,
} from '@poe-worksmith/domain';

export type GuidedOutcome = {
  id: string;
  name: string;
  classification: 'premium' | 'target' | 'imperfect' | 'salvage' | 'unusable';
  probability: string;
  probabilitySource: string;
  targetSuccess: boolean;
  sellable: boolean;
  resaleMin: string;
  resaleMax: string;
  resaleSource: string;
  resaleConfirmed: boolean;
  finishing: string;
  recovery: string;
};

export type GuidedOutcomeDraft = {
  currency: 'chaos' | 'divine';
  base: string;
  materials: string;
  costSource: string;
  assumptions: string;
  exclusive: boolean;
  outcomes: GuidedOutcome[];
};

export function emptyGuidedOutcome(id: string): GuidedOutcome {
  return {
    id,
    name: '',
    classification: 'target',
    probability: '',
    probabilitySource: '',
    targetSuccess: false,
    sellable: false,
    resaleMin: '',
    resaleMax: '',
    resaleSource: '',
    resaleConfirmed: false,
    finishing: '',
    recovery: '',
  };
}

/** The basic editor models one completed attempt, with no hidden retries. */
export function buildGuidedOutcomeInput(
  draft: GuidedOutcomeDraft,
  league: string,
  now: string,
): OutcomeAnalysisInput {
  if (!draft.exclusive)
    throw new Error(
      'Confirm that the outcomes are mutually exclusive and cover every possible result.',
    );
  if (!draft.assumptions.trim() || !draft.costSource.trim())
    throw new Error('Document the model assumptions and cost source.');
  const evidence = (
    reference: string,
    kind: OutcomeProvenance['kind'] = 'assumption',
  ): OutcomeProvenance => ({
    kind,
    reference,
    recordedAt: now,
    notes: draft.assumptions,
  });
  const costEvidence = evidence(draft.costSource);
  const prices: OutcomeAnalysisInput['prices'] = {};
  const valuations: OutcomeAnalysisInput['valuations'] = {};
  const cost = (
    kind: 'base' | 'material' | 'finishing' | 'recovery',
    resourceId: string,
    amount: string,
  ) => {
    prices[resourceId] = {
      amount: amount.trim(),
      currency: draft.currency,
      provenance: costEvidence,
    };
    return { kind, resourceId, quantity: '1', provenance: costEvidence };
  };
  const stageCosts = [
    cost('base', 'manual-base', draft.base),
    cost('material', 'manual-materials', draft.materials),
  ];
  const outcomes = draft.outcomes.map((row) => {
    const matching = { kind: 'manual' as const, description: row.name };
    if (row.sellable) {
      valuations[row.id] = {
        min: row.resaleMin.trim(),
        max: row.resaleMax.trim(),
        currency: draft.currency,
        matching,
        provenance: evidence(
          row.resaleSource,
          row.resaleConfirmed ? 'transaction' : 'assumption',
        ),
      };
    }
    return {
      id: row.id,
      name: row.name,
      classification: row.classification,
      probability: {
        value: row.probability.trim() || null,
        provenance: row.probability.trim()
          ? evidence(row.probabilitySource)
          : null,
      },
      nextStageId: null,
      targetSuccess: row.targetSuccess,
      sellable: row.sellable,
      matching,
      costs: [
        cost('finishing', `${row.id}-finishing`, row.finishing),
        cost('recovery', `${row.id}-recovery`, row.recovery),
      ],
      credits: [],
      unknowns: [],
    };
  });
  return outcomeAnalysisInputSchema.parse({
    model: {
      version: 1,
      id: 'owner-attempt-model',
      startStageId: 'attempt',
      unknowns: [],
      stages: [
        {
          id: 'attempt',
          name: 'One completed crafting attempt',
          costs: stageCosts,
          exclusivity: {
            mode: 'disjoint',
            provenance: evidence(draft.assumptions),
          },
          outcomes,
        },
      ],
    },
    currency: draft.currency,
    league,
    now,
    prices,
    valuations,
  });
}
