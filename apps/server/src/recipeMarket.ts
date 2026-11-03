import {
  canonicalCraftSetupFromRecipe,
  aggregateMarketListings,
  type MarketListing,
  type CanonicalJsonObject,
  type LoadedRecipeDefinition,
  type TradeQueryGenerator,
} from '@poe-worksmith/domain';
import { z } from 'zod';
import { normalizeTradeCompatibleListing } from './providers/tradeCompatible.js';
import {
  canonicalMarketJson,
  createMarketTarget,
  createImportedMarketSnapshot,
} from './marketResearch.js';
import { analyzeBeltSnapshot } from './beltComparability.js';
import { marketTargetInputSchema } from '@poe-worksmith/contracts';

export type RecipeMarketQuery = {
  provider: 'poe-trade';
  query: CanonicalJsonObject;
  schemaVersion: 1;
};
export type RecipeMarketDependency =
  | Readonly<{
      kind: 'base' | 'target';
      query: RecipeMarketQuery;
      materialId?: never;
    }>
  | Readonly<{
      kind: 'material';
      materialId: string;
      query: RecipeMarketQuery | null;
    }>;
export type RecipeMarketDependencies = (input: {
  league: string;
  recipe: LoadedRecipeDefinition;
}) => Promise<readonly RecipeMarketDependency[]>;

export function createRecipeMarketDependencies(options: {
  trade: TradeQueryGenerator;
  resolveResource(
    itemId: string,
    gameDataVersion: string,
  ): Promise<string | null>;
}): RecipeMarketDependencies {
  return async ({ league, recipe }) => {
    const resourceIds = new Set(
      recipe.craft.steps.flatMap((step) =>
        step.materials.map(({ itemId }) => itemId),
      ),
    );
    return [
      {
        kind: 'base',
        query: await generateRecipeMarketQuery(
          options.trade,
          recipe,
          league,
          true,
        ),
      },
      ...(await Promise.all(
        [...resourceIds].sort().map(async (materialId) => {
          const exchangeId =
            materialId === 'chaos-orb'
              ? null
              : await options.resolveResource(
                  materialId,
                  recipe.gameDataVersion,
                );
          return {
            kind: 'material' as const,
            materialId,
            query: exchangeId
              ? tradeQuery({
                  exchange: { have: ['chaos'], want: [exchangeId] },
                })
              : null,
          };
        }),
      )),
      {
        kind: 'target',
        query: await generateRecipeMarketQuery(options.trade, recipe, league),
      },
    ];
  };
}
function tradeQuery(query: Record<string, unknown>): RecipeMarketQuery {
  return {
    provider: 'poe-trade',
    query: z.record(z.string(), z.json()).parse(query),
    schemaVersion: 1,
  };
}

const generatedSearch = z.object({
  query: z.object({
    type: z.string(),
    stats: z
      .array(
        z.object({
          type: z.literal('and'),
          filters: z.array(
            z.object({
              id: z.string(),
              value: z
                .object({
                  min: z.number().optional(),
                  max: z.number().optional(),
                })
                .optional(),
            }),
          ),
        }),
      )
      .default([]),
  }),
});

export async function generateRecipeMarketQuery(
  trade: TradeQueryGenerator,
  recipe: LoadedRecipeDefinition,
  league: string,
  starting = false,
): Promise<RecipeMarketQuery> {
  const setup = canonicalCraftSetupFromRecipe(recipe);
  const result = await trade.generate({
    league,
    setup: starting
      ? {
          ...setup,
          base: recipe.startingBase,
          target: {
            allOf: recipe.craft.startingMods.map(
              ({ modId, tier, kind, minimumValue, maximumValue }) => ({
                kind: kind ?? 'explicit',
                modId,
                excluded: false,
                ...(tier ? { exactTier: tier } : {}),
                ...(minimumValue === undefined ? {} : { minimumValue }),
                ...(maximumValue === undefined ? {} : { maximumValue }),
              }),
            ),
            anyOf: [],
            minimumMatched: null,
          },
        }
      : setup,
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map(({ code }) => code).join(','));
  const generated = generatedSearch.parse(result.value.query);
  const item = starting ? recipe.startingBase : recipe.base;
  const handbookTarget = marketTargetInputSchema.parse({
    name: starting
      ? `base:${item.baseId}`.slice(0, 200)
      : recipe.targetSignature,
    game: 'poe1',
    realm: 'pc',
    league,
    patch: recipe.patch,
    slot: starting ? 'starting-base' : 'crafted-item',
    baseTypes: [generated.query.type],
    builds: [],
    requiredMods: [],
    sources: [],
    minItemLevel: item.itemLevel,
    influences: [...item.influences].sort(),
    corrupted: item.state.corrupted,
    synthesised: item.state.synthesised,
    tradeSearch: {
      version: 1,
      scope: 'strict',
      status: 'securable',
      currency: 'chaos',
      includeOtherCurrencies: true,
      rarity: item.rarity,
      fractured: item.state.fractured,
      groups: generated.query.stats.map((g) => ({
        type: g.type,
        filters: g.filters.map((stat) => ({
          id: stat.id,
          ...result.value.matchRules?.find((rule) => rule.id === stat.id),
          ...(stat.value?.min !== undefined ? { min: stat.value.min } : {}),
          ...(stat.value?.max !== undefined ? { max: stat.value.max } : {}),
        })),
      })),
    },
  });
  handbookTarget.tradeSearch?.groups.forEach((g) =>
    g.filters.sort((a, b) => a.id.localeCompare(b.id)),
  );
  return tradeQuery({
    ...result.value.query,
    handbookTarget: canonicalMarketJson(handbookTarget),
  });
}

export function comparableRecipeListings(
  query: CanonicalJsonObject,
  listings: readonly MarketListing[],
  capturedAt: Date,
  now: Date,
) {
  if (!query.handbookTarget) return [...listings];
  const target = recipeQueryTarget(query.handbookTarget);
  // Raw provider observations remain immutable; matching uses the current normalizer.
  const normalizedListings = listings.flatMap((row) => {
    if (!row.item.rawListing) return [row];
    try {
      const normalized = normalizeTradeCompatibleListing(
        row.item.rawListing,
        target,
      );
      return [
        {
          ...row,
          item: {
            ...normalized.item,
            rawListing: row.item.rawListing,
            currency: row.price.currency,
            ...(row.item.exchange ? { exchange: row.item.exchange } : {}),
          },
        },
      ];
    } catch {
      return [];
    }
  });
  const imported = createImportedMarketSnapshot(
    {
      targetId: target.id,
      capturedAt: capturedAt.toISOString(),
      sourceUrl: 'https://www.pathofexile.com/trade',
      currency: 'chaos',
      dataKind: 'observed',
      emptyResult: normalizedListings.length === 0,
      listings: normalizedListings
        .filter(
          (row) =>
            typeof row.item.league !== 'string' ||
            row.item.league === target.league,
        )
        .map((row) => ({
          externalId: row.id,
          price: Number(row.price.amount),
          currency: row.price.currency,
          item: row.item,
        })),
    },
    target,
    now,
  );
  const matches = new Set(
    analyzeBeltSnapshot(target, imported, now.getTime())
      .rows.filter((row) => row.status === 'MATCH')
      .map((row) => row.externalId),
  );
  return [
    ...aggregateMarketListings({
      currency: 'chaos',
      listings: normalizedListings.filter((row) => matches.has(row.id)),
    }).listings,
  ];
}

// Keep explicit empty constraints inside the generic query canonicalizer, which drops empty query containers.
export function recipeQueryTarget(value: unknown) {
  return createMarketTarget(JSON.parse(z.string().parse(value)));
}
