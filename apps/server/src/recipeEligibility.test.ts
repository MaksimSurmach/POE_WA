import {
  RegisteredTradeQueryGenerator,
  mappedTargetFilter,
  noVariantFilter,
  hashMarketQuery,
  type Recipe,
  type ScrapedItemSpec,
} from '@poe-worksmith/domain';
import {
  canonicalRecipeFixture,
  fixtureRecipe,
} from '@poe-worksmith/domain/fixtures';
import { describe, expect, it } from 'vitest';

import { evaluateFreshRecipe, type QuoteEvidence } from './catalogPublisher.js';
import {
  createRecipeMarketDependencies,
  matchingRecipeListings,
} from './recipeMarket.js';
import {
  derivedRecipeSpecs,
  type RecipeSpecResolver,
} from './scrapedItemConfig.js';

const league = 'Fixture League';
const now = new Date('2026-11-18T12:00:00.000Z');
const trade = new RegisteredTradeQueryGenerator(
  {
    async resolveBase({ baseId }) {
      return {
        ok: true,
        diagnostics: [],
        value: { id: baseId, mappingVersion: 'fixture' },
      };
    },
    async resolveTarget({ target }) {
      return {
        ok: true,
        diagnostics: [],
        value: {
          id: `${target.kind}.stat_${target.modId === 'life' ? '3299347043' : '3680664274'}`,
        },
      };
    },
  },
  [noVariantFilter],
  [mappedTargetFilter],
);

// A recipe whose finished item needs a strong life roll and whose starting
// base needs a fractured suppression roll; both are the recipe's own goal.
const recipe = fixtureRecipe({
  ...canonicalRecipeFixture,
  startingBase: {
    ...canonicalRecipeFixture.startingBase,
    rarity: 'rare',
    state: { corrupted: false, fractured: true, synthesised: false },
  },
  craft: {
    ...canonicalRecipeFixture.craft,
    startingMods: [
      {
        modId: 'suppression',
        kind: 'fractured',
        minimumValue: 14,
        maximumValue: 14,
      },
    ],
  },
  target: {
    ...canonicalRecipeFixture.target,
    prefixes: [{ kind: 'explicit', modId: 'life', minimumValue: 100 }],
  },
});
const stored = {
  active: true,
  category: 'jewel',
  contentHash: 'fixture',
  craftMethod: 'harvest',
  definition: recipe,
  gameVersion: recipe.patch,
  guideMarkdown: '# Guide',
  id: 'recipe',
  tags: [],
  title: 'Recipe',
} as unknown as Recipe;

/** The owner's configured requirements, applied over the recipe's authored ones. */
const configured = (
  change: (specs: { base: ScrapedItemSpec; output: ScrapedItemSpec }) => void,
): RecipeSpecResolver => {
  return async (input) => {
    const authored = (await derivedRecipeSpecs(input)) as {
      base: { spec: ScrapedItemSpec };
      output: { spec: ScrapedItemSpec };
    };
    const specs = {
      base: structuredClone(authored.base.spec),
      output: structuredClone(authored.output.spec),
    };
    change(specs);
    return {
      base: { spec: specs.base, configured: { id: 'base-item', revision: 2 } },
      output: {
        spec: specs.output,
        configured: { id: 'output-item', revision: 2 },
      },
    };
  };
};

const listing = (
  id: string,
  price: number,
  item: Record<string, unknown>,
  account = `seller-${id}`,
) => ({
  id,
  account,
  ageSeconds: 0,
  fee: null,
  indexedAt: now.toISOString(),
  price: { amount: String(price), currency: 'chaos' },
  item: {
    baseType: 'Large Cluster Jewel',
    rarity: 'rare',
    league,
    patch: recipe.patch,
    itemLevel: 84,
    corrupted: false,
    synthesised: false,
    fractured: false,
    influences: [],
    seller: account,
    status: 'listed',
    currency: 'chaos',
    modsComplete: true,
    mods: [],
    ...item,
  },
});

const evaluate = async (specs: RecipeSpecResolver, available: object) => {
  const marketDependencies = createRecipeMarketDependencies({
    resolveResource: async () => null,
    specs,
    trade,
  });
  const dependencies = await marketDependencies({ league, recipe });
  const byHash = new Map<string, QuoteEvidence>();
  for (const dependency of dependencies) {
    if (!dependency.query) continue;
    const hash = await hashMarketQuery({
      league,
      provider: dependency.query.provider,
      query: dependency.query.query,
      schemaVersion: dependency.query.schemaVersion,
    });
    const listings = (
      available as Record<string, ReturnType<typeof listing>[]>
    )[dependency.kind];
    if (listings)
      byHash.set(hash, {
        capturedAt: now,
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        payload: {
          coverage: 'complete',
          listings,
          sortedSampleComplete: false,
          totalResults: listings.length,
        },
        revalue: false,
      });
  }
  return {
    dependencies,
    evaluation: await evaluateFreshRecipe(
      stored,
      { league, now, quotes: async (hash) => byHash.get(hash) ?? null },
      { allowMissingOutput: true, currencyExchange: null, marketDependencies },
    ),
  };
};

const strongOutput = (id: string, price: number) =>
  listing(id, price, {
    mods: [{ id: 'explicit.stat_3299347043', value: 120, tier: 1 }],
  });
const weakOutput = (id: string, price: number) =>
  listing(id, price, {
    mods: [{ id: 'explicit.stat_3299347043', value: 5, tier: 4 }],
  });
const fracturedBase = (id: string, price: number) =>
  listing(id, price, {
    fractured: true,
    itemLevel: recipe.startingBase.itemLevel,
    mods: [{ id: 'fractured.stat_3680664274', value: 14, tier: 1 }],
  });
describe('recipe economics under edited scraped-item searches', () => {
  it('keeps the effective search authoritative and attaches the recipe goal only when they differ', async () => {
    const authored = await createRecipeMarketDependencies({
      resolveResource: async () => null,
      specs: derivedRecipeSpecs,
      trade,
    })({ league, recipe });
    expect(authored.every((dependency) => !dependency.eligibility)).toBe(true);

    const relaxed = configured(({ output }) => {
      output.conditions = output.conditions.map((condition) => ({
        ...condition,
        minimumValue: 1,
      }));
    });
    const { dependencies } = await evaluate(relaxed, {});
    const target = dependencies.find(({ kind }) => kind === 'target')!;
    const originalTarget = authored.find(({ kind }) => kind === 'target')!;
    // What is fetched, hashed and linked is the owner's search...
    expect(target.query).not.toEqual(originalTarget.query);
    // ...while the recipe's own requirement is still the original, byte for byte.
    expect(target.eligibility).toEqual(originalTarget.query);
    expect(
      dependencies.find(({ kind }) => kind === 'base')?.eligibility,
    ).toBeUndefined();

    const capturedAt = now;
    const weak = weakOutput('weak', 1) as never;
    expect(
      matchingRecipeListings(target.query!.query, [weak], capturedAt, now),
    ).toHaveLength(1);
    expect(
      matchingRecipeListings(
        target.eligibility!.query,
        [weak],
        capturedAt,
        now,
      ),
    ).toHaveLength(0);
  });

  it('does not price a recipe from listings that only meet a weakened output search', async () => {
    const relaxed = configured(({ output }) => {
      output.conditions = output.conditions.map((condition) => ({
        ...condition,
        minimumValue: 1,
      }));
    });
    // The relaxed search collected a cheap weak item; only the strong one is the recipe's goal.
    const weak = await evaluate(relaxed, {
      base: [fracturedBase('b1', 10)],
      target: [weakOutput('w1', 1)],
    });
    expect(weak.evaluation.estimatedSalePrice).toBeNull();

    const mixed = await evaluate(relaxed, {
      base: [fracturedBase('b1', 10)],
      target: [weakOutput('w1', 1), strongOutput('s1', 5000)],
    });
    expect(Number(mixed.evaluation.estimatedSalePrice)).toBe(5000);

    // Without any edit the same strong listing prices the recipe identically.
    const unedited = await evaluate(derivedRecipeSpecs, {
      base: [fracturedBase('b1', 10)],
      target: [strongOutput('s1', 5000)],
    });
    expect(Number(unedited.evaluation.estimatedSalePrice)).toBe(5000);
  });

  it('does not price a crafting base from listings that only meet a weakened starting search', async () => {
    const relaxed = configured(({ base }) => {
      // The owner widens the fractured roll the base search collects.
      base.conditions = base.conditions.map((condition) => ({
        ...condition,
        minimumValue: 1,
        maximumValue: 100,
      }));
    });
    const weakFracture = (id: string, price: number) =>
      listing(id, price, {
        fractured: true,
        itemLevel: recipe.startingBase.itemLevel,
        mods: [{ id: 'fractured.stat_3680664274', value: 3, tier: 3 }],
      });
    // The widened search collects it, but its roll is not the recipe's authored input.
    const weakOnly = await evaluate(relaxed, {
      base: [weakFracture('w1', 1)],
      target: [strongOutput('s1', 5000)],
    });
    expect(weakOnly.evaluation.methodCost?.baseCost ?? null).toBeNull();

    const withExact = await evaluate(relaxed, {
      base: [weakFracture('w1', 1), fracturedBase('f1', 40)],
      target: [strongOutput('s1', 5000)],
    });
    expect(withExact.evaluation.methodCost?.baseCost).toMatchObject({
      amount: '40',
    });
  });
});
