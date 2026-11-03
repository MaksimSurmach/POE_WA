import type {
  RecipeMarketDependencies,
  RecipeMarketQuery,
} from '../recipeMarket.js';
export const fixtureMarketDependencies: RecipeMarketDependencies = async ({
  recipe,
}) => {
  const query = (type: string): RecipeMarketQuery => ({
    provider: 'poe-trade',
    schemaVersion: 1,
    query: { query: { type } },
  });
  return [
    { kind: 'base', query: query(recipe.base.baseId) },
    ...[
      ...new Set(
        recipe.craft.steps.flatMap((s) => s.materials.map((m) => m.itemId)),
      ),
    ].map((materialId) => ({
      kind: 'material' as const,
      materialId,
      query: query(materialId),
    })),
    {
      kind: 'target',
      query: query(recipe.base.baseId.replace('Base ', 'Output ') + ':output'),
    },
  ];
};
