import {
  aggregateMarketListings,
  type CanonicalRecipeV1,
  type TradeQueryGenerator,
  validateRecipeV2,
} from '@poe-worksmith/domain';
import { calculateRecipeEconomics } from '@poe-worksmith/domain/economics';
import { describe, expect, it } from 'vitest';

import { createV2RecipeMarketDependencies } from './recipeMarket.js';

const recipe = validateRecipeV2({
  base: {
    baseId: 'Metadata/Items/Jewels/JewelPassiveTreeExpansionLarge',
    influences: [],
    itemLevel: 83,
    rarity: 'rare',
    state: { corrupted: false, fractured: false, synthesised: false },
    variant: {
      kind: 'cluster-jewel',
      passiveCount: 8,
      smallPassiveStatId: 'physical-damage',
    },
  },
  category: 'cluster-jewel',
  content: { craftSteps: [{ id: 'craft', title: 'Craft' }] },
  craft: {
    method: { kind: 'fossil', fossils: ['jagged-fossil'], resonatorSockets: 1 },
    resourceConsumption: {
      source: 'authored-estimate',
      materials: [
        { itemId: 'jagged-fossil', quantity: 30 },
        { itemId: 'primitive-chaotic-resonator', quantity: 30 },
      ],
    },
    startingMods: [],
    variants: [
      {
        id: 'harvest-physical',
        name: 'Harvest Physical Reforge',
        evidence: {
          method: 'PoE Wiki manual reference',
          patch: '3.26',
          url: 'https://www.poewiki.net/wiki/List_of_harvest_crafting_options',
          verifiedAt: '2026-11-02',
        },
        steps: [
          {
            id: 'reforge-physical',
            title: 'Reforge with Physical modifiers',
            action: 'Use the Physical reforge.',
            materials: [
              { itemId: 'vivid-crystallised-lifeforce', quantity: 50 },
            ],
            continueWhen: 'The target modifiers are present.',
            failureAction: 'Repeat.',
          },
        ],
      },
    ],
  },
  gameDataVersion: '3.26.0',
  id: 'physical-large-cluster-jagged',
  schemaVersion: 2,
  tags: ['profit'],
  title: 'Physical Large Cluster Jewel',
  target: {
    allOf: [
      { kind: 'explicit', modId: 'mod:battle-hardened' },
      { kind: 'explicit', modId: 'mod:furious-assault' },
      { kind: 'explicit', modId: 'mod:master-the-fundamentals' },
    ],
    anyOf: [],
    minimumMatched: null,
  },
});

const trade: TradeQueryGenerator = {
  async generate({ setup }) {
    return {
      diagnostics: [],
      ok: true,
      value: {
        diagnostics: {
          gameDataVersion: setup.gameDataVersion,
          mappingVersion: 'fixture',
        },
        hash: 'fixture',
        query: {
          query: {
            stats: setup.target.allOf.map(({ modId }) => ({ id: modId })),
            status: { option: 'securable' },
            type: 'Large Cluster Jewel',
          },
          sort: { price: 'asc' },
        },
      },
    };
  },
};

describe('physical large cluster vertical fixture', () => {
  it('queries each legacy and variant material once with league-scoped trade queries', async () => {
    const dependencies = await createV2RecipeMarketDependencies({
      trade,
      resolveResource: async (id) =>
        ({
          'jagged-fossil': 'jagged-fossil',
          'primitive-chaotic-resonator': 'primitive-chaotic-resonator',
          'vivid-crystallised-lifeforce': 'vivid-crystallised-lifeforce',
        })[id]!,
    })({ league: 'Mercenaries', recipe });
    expect(dependencies).toHaveLength(5);
    expect(dependencies.map(({ materialId }) => materialId)).toEqual([
      undefined,
      'jagged-fossil',
      'primitive-chaotic-resonator',
      'vivid-crystallised-lifeforce',
      undefined,
    ]);
    expect(
      dependencies
        .filter(({ kind }) => kind === 'material')
        .map(({ query }) => query.provider),
    ).toEqual(['poe-trade', 'poe-trade', 'poe-trade']);
    expect(
      dependencies
        .filter(({ kind }) => kind === 'material')
        .map(({ query }) => query.query),
    ).toEqual([
      { exchange: { have: ['chaos'], want: ['jagged-fossil'] } },
      {
        exchange: {
          have: ['chaos'],
          want: ['primitive-chaotic-resonator'],
        },
      },
      {
        exchange: {
          have: ['chaos'],
          want: ['vivid-crystallised-lifeforce'],
        },
      },
    ]);
    expect(dependencies.at(-1)?.query.query).toMatchObject({
      query: {
        stats: [
          { id: 'mod:battle-hardened' },
          { id: 'mod:furious-assault' },
          { id: 'mod:master-the-fundamentals' },
        ],
        status: { option: 'securable' },
      },
    });

    const economics = calculateRecipeEconomics({
      aggregation: aggregateMarketListings({
        currency: 'chaos',
        listings: Array.from({ length: 10 }, (_, index) => ({
          account: `seller-${index}`,
          ageSeconds: 60,
          fee: null,
          id: `sale-${index}`,
          indexedAt: new Date('2026-07-20T00:00:00.000Z'),
          item: {},
          price: { amount: '180', currency: 'chaos' },
        })),
      }),
      basePrice: { amount: '10', currency: 'chaos' },
      currency: 'chaos',
      finishingPrices: {},
      materialPrices: {
        'jagged-fossil': { amount: '2', currency: 'chaos' },
        'primitive-chaotic-resonator': { amount: '1', currency: 'chaos' },
      },
      recipe: {
        baseRequirements: {
          baseType: 'Large Cluster Jewel',
          tradeQuery: dependencies[0]!.query,
        },
        category: 'cluster-jewel',
        craftSteps: [{ id: 'craft', title: 'Craft' }],
        estimator: { strategy: 'median_top_n', n: 10 },
        finishingCosts: [],
        gameVersion: '3.26.0',
        id: recipe.id,
        materials: [
          {
            id: 'jagged-fossil',
            label: 'Jagged Fossil',
            quantityPerAttempt: 30,
            tradeQuery: dependencies[1]!.query,
          },
          {
            id: 'primitive-chaotic-resonator',
            label: 'Primitive Chaotic Resonator',
            quantityPerAttempt: 30,
            tradeQuery: dependencies[2]!.query,
          },
        ],
        output: { label: recipe.title, tradeQuery: dependencies[4]!.query },
        schemaVersion: 1,
        success: { mode: 'expected_attempts', expectedAttempts: 1 },
        summary: recipe.title,
        tags: ['profit'],
        title: recipe.title,
      } satisfies CanonicalRecipeV1,
    });
    expect(economics).toMatchObject({
      ok: true,
      value: {
        breakdown: { expectedCraftCost: { amount: '100' } },
        profit: { amount: '80' },
        marginPercent: '80',
      },
    });
  });
});
