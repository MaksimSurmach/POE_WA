import {
  recipeDetailViewSchema,
  type CatalogEntry,
  type RecipeDetailView,
} from '@poe-worksmith/contracts';

import { catalogFixtures } from './catalog.js';

const defaultGuide = {
  gameVersion: 'Settlers 3.25',
  confidence: 'medium',
  base: {
    name: 'Large Cluster Jewel',
    requirements: [
      'Item level 84+',
      '8 passives',
      '12% increased Physical Damage',
    ],
  },
  materials: [
    {
      name: 'Harvest: Reforge with more Physical modifiers',
      quantityPerAttempt: 1,
      unitPrice: { amount: 0.45, currency: 'divine' },
      costPerAttempt: { amount: 0.45, currency: 'divine' },
    },
    {
      name: 'Wild Bristle Matron Lifeforce',
      quantityPerAttempt: 150,
      unitPrice: { amount: 0.0003, currency: 'divine' },
      costPerAttempt: { amount: 0.045, currency: 'divine' },
    },
    {
      name: 'Vivid Crystallised Lifeforce',
      quantityPerAttempt: 25,
      unitPrice: { amount: 0.0002, currency: 'divine' },
      costPerAttempt: { amount: 0.005, currency: 'divine' },
    },
  ],
  craftSteps: [
    'Acquire a Large Cluster Jewel item level 84+ with 8 passives and 12% increased Physical Damage.',
    'Use Harvest: Reforge with more Physical modifiers on the jewel.',
    'Check for exactly three notable passive skills.',
    'Repeat the reforge when the required notable set is missing.',
    'Apply the one-time finishing craft after the target mods appear.',
    'Price-check the result against current Merchant listings.',
  ],
  requiredMods: [
    'Exactly 3 notable passive skills',
    'All notable passive skills have the Physical tag',
    '8 passives and item level 84+',
  ],
  costBreakdown: {
    baseCost: { amount: 1, currency: 'divine' },
    materialsPerAttempt: { amount: 0.5, currency: 'divine' },
    expectedAttempts: 6,
    finishingCost: { amount: 0.1, currency: 'divine' },
    expectedCost: { amount: 4.1, currency: 'divine' },
  },
  estimators: [
    {
      id: 'cheapest',
      label: 'Cheapest',
      price: { amount: 8, currency: 'divine' },
    },
    {
      id: 'third-cheapest',
      label: '3rd cheapest',
      price: { amount: 8.2, currency: 'divine' },
    },
    {
      id: 'median-top-5',
      label: 'Median top 5',
      price: { amount: 8.4, currency: 'divine' },
    },
  ],
  selectedEstimatorId: 'third-cheapest',
} satisfies Omit<RecipeDetailView, 'evaluation' | 'recipe' | 'snapshot'>;

function createDetail(
  entry: CatalogEntry,
  overrides: Partial<RecipeDetailView> = {},
): RecipeDetailView {
  return recipeDetailViewSchema.parse({
    ...defaultGuide,
    recipe: entry.recipe,
    evaluation: entry.evaluation,
    snapshot: entry.snapshot,
    ...overrides,
  });
}

export const recipeDetails = catalogFixtures.map((entry) => {
  if (entry.recipe.id === 'no-listings-bow') {
    return createDetail(entry, {
      estimators: [],
      selectedEstimatorId: null,
    });
  }

  if (entry.recipe.id === 'calculation-error-amulet') {
    return createDetail(entry, {
      confidence: null,
      costBreakdown: null,
      estimators: [],
      selectedEstimatorId: null,
    });
  }

  if (entry.recipe.id === 'loading-gloves') {
    return createDetail(entry, {
      confidence: null,
      costBreakdown: null,
      estimators: [],
      selectedEstimatorId: null,
    });
  }

  return createDetail(entry);
});

export const profitableRecipeDetail = recipeDetails.find(
  ({ recipe }) => recipe.id === 'profitable-cluster',
)!;
