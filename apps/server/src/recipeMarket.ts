import {
  canonicalCraftSetupFromRecipe,
  type CanonicalRecipeV1,
  type CanonicalJsonObject,
  type GeneratedTradeQuery,
  type LoadedRecipeDefinition,
  type TradeQueryGenerator,
} from '@poe-worksmith/domain';

export type RecipeMarketDependency = Readonly<{
  kind: 'base' | 'finishing' | 'material' | 'target';
  materialId?: string;
  query: CanonicalRecipeV1['baseRequirements']['tradeQuery'];
}>;

export type RecipeMarketDependencies = (input: {
  league: string;
  recipe: LoadedRecipeDefinition;
}) => Promise<readonly RecipeMarketDependency[]>;

export function legacyRecipeMarketDependencies(input: {
  recipe: CanonicalRecipeV1;
}): readonly RecipeMarketDependency[] {
  return [
    { kind: 'base', query: input.recipe.baseRequirements.tradeQuery },
    ...input.recipe.materials.map(({ id, tradeQuery }) => ({
      kind: 'material' as const,
      materialId: id,
      query: tradeQuery,
    })),
    ...input.recipe.finishingCosts.map(({ id, tradeQuery }) => ({
      kind: 'finishing' as const,
      materialId: id,
      query: tradeQuery,
    })),
    { kind: 'target', query: input.recipe.output.tradeQuery },
  ];
}

export function createV2RecipeMarketDependencies(options: {
  trade: TradeQueryGenerator;
  resolveResource(itemId: string, gameDataVersion: string): Promise<string>;
}): RecipeMarketDependencies {
  return async ({ league, recipe }) => {
    if (recipe.schemaVersion === 1)
      return legacyRecipeMarketDependencies({ recipe });
    const base = await generated(options.trade, league, {
      ...canonicalCraftSetupFromRecipe(recipe),
      target: { allOf: [], anyOf: [], minimumMatched: null },
    });
    const target = await generated(
      options.trade,
      league,
      canonicalCraftSetupFromRecipe(recipe),
    );
    const materials = await Promise.all(
      (recipe.craft.resourceConsumption?.materials ?? []).map(async (item) => ({
        kind: 'material' as const,
        materialId: item.itemId,
        query: tradeQuery({
          exchange: {
            have: ['chaos'],
            want: [
              await options.resolveResource(
                item.itemId,
                recipe.gameDataVersion,
              ),
            ],
          },
          sort: { price: 'asc' },
        }),
      })),
    );
    return [
      { kind: 'base', query: tradeQuery(base.query) },
      ...materials,
      { kind: 'target', query: tradeQuery(target.query) },
    ];
  };
}

function tradeQuery(
  query: Record<string, unknown>,
): CanonicalRecipeV1['baseRequirements']['tradeQuery'] {
  return {
    provider: 'poe-trade',
    query:
      query as unknown as CanonicalRecipeV1['baseRequirements']['tradeQuery']['query'],
    schemaVersion: 1,
  };
}

async function generated(
  trade: TradeQueryGenerator,
  league: string,
  setup: Parameters<TradeQueryGenerator['generate']>[0]['setup'],
): Promise<GeneratedTradeQuery> {
  const result = await trade.generate({ league, setup });
  if (!result.ok)
    throw new Error(result.diagnostics.map(({ code }) => code).join(','));
  return result.value;
}
