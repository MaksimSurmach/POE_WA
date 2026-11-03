import {
  validateRecipeDocument,
  recipeTargetSignature,
  recipeSchema,
  type RecipeInput,
} from '../recipeSchema.js';

export const economicsFixture = {
  estimator: { n: 10, strategy: 'median_top_n' as const },
  finishingCosts: [{ id: 'divine-orb', label: 'Divine Orb', quantity: 1 }],
  materials: [
    {
      id: 'primal-crystallised-lifeforce',
      label: 'Primal Crystallised Lifeforce',
      quantityPerAttempt: 150,
    },
  ],
  success: { expectedAttempts: 6, mode: 'expected_attempts' as const },
};

const evidence = {
  method: 'Labelled synthetic fixture',
  patch: 'fixture-1',
  url: 'https://example.com/fixture',
  verifiedAt: '2026-11-02',
  settings: 'Deterministic test input',
  artifact: 'fixture',
  assumptions: 'Independent same-base rolls; includes all stages.',
};
const fixtureInput: RecipeInput = {
  schemaVersion: 3,
  id: 'physical-large-cluster',
  title: 'Physical Large Cluster Jewel',
  summary: 'Synthetic fixture',
  category: 'cluster-jewel',
  tags: ['profit', 'cluster-jewel'],
  gameDataVersion: 'fixture-1',
  patch: 'fixture-1',
  targetSignature: 'pending',
  base: {
    baseId: 'Large Cluster Jewel',
    itemLevel: 84,
    rarity: 'rare',
    influences: [],
    state: { corrupted: false, fractured: false, synthesised: false },
    variant: { kind: 'none' },
  },
  startingBase: {
    baseId: 'Large Cluster Jewel',
    itemLevel: 84,
    rarity: 'normal',
    influences: [],
    state: { corrupted: false, fractured: false, synthesised: false },
    variant: { kind: 'none' },
  },
  target: { prefixes: [], suffixes: [], implicits: [], other: [] },
  craft: {
    id: 'harvest',
    name: 'Harvest Physical',
    method: { kind: 'harvest-reforge', tag: 'physical' },
    startingMods: [],
    uncertainties: [],
    evidence,
    steps: [
      {
        id: 'roll',
        title: 'Roll',
        action: 'Roll once',
        continueWhen: 'Target reached',
        failureAction: 'Repeat on the same base',
        materials: [{ itemId: 'primal-crystallised-lifeforce', quantity: 150 }],
      },
    ],
    expectedExecutions: [{ stepId: 'roll', count: 6, evidence }],
    baseConsumption: { expectedBases: 1, evidence },
  },
  verification: {
    status: 'verified',
    leagues: ['Fixture League', 'Mercenaries', 'Standard'],
    checkedAt: '2026-11-02',
    sources: ['https://example.com/fixture'],
    notes: 'Synthetic only',
  },
};
export const canonicalRecipeFixture = validateRecipeDocument({
  ...fixtureInput,
  targetSignature: recipeTargetSignature(recipeSchema.parse(fixtureInput)),
});
export function fixtureRecipe(input: unknown = canonicalRecipeFixture) {
  const parsed = recipeSchema.parse(input);
  return validateRecipeDocument({
    ...parsed,
    targetSignature: recipeTargetSignature(parsed),
  });
}
