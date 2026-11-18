import {
  scrapedItemDigest,
  scrapedItemSpecFromRecipe,
  type LoadedRecipeDefinition,
  type ScrapedItemRole,
  type ScrapedItemSpec,
} from '@poe-worksmith/domain';

/** The requirement a recipe is actually scraped with, and where it came from. */
export type EffectiveScrapedItem = Readonly<{
  spec: ScrapedItemSpec;
  /** The owner-visible configured item, or null when only the recipe is known. */
  configured: Readonly<{ id: string; revision: number }> | null;
}>;
export type RecipeScrapedItems = Readonly<
  Record<ScrapedItemRole, EffectiveScrapedItem>
>;

/**
 * The single place that decides which requirements a recipe's base and output
 * searches use. Schedule synchronization, result publication, the generated
 * Trade link and test diagnostics all resolve through one of these.
 */
export type RecipeSpecResolver = (
  recipe: LoadedRecipeDefinition,
) => RecipeScrapedItems | Promise<RecipeScrapedItems>;

/** Requirements as authored in the recipe, for recipes without a configured item. */
export const derivedRecipeSpecs: RecipeSpecResolver = (recipe) => ({
  base: { spec: scrapedItemSpecFromRecipe(recipe, 'base'), configured: null },
  output: {
    spec: scrapedItemSpecFromRecipe(recipe, 'output'),
    configured: null,
  },
});

/**
 * Names the requirements a recipe is being scraped with. Two identical values
 * mean the same searches, so a stored result can only be served while the
 * identity it was computed from is still the recipe's current one.
 */
export async function recipeScrapedIdentity(
  recipe: LoadedRecipeDefinition,
  specs: RecipeSpecResolver,
) {
  const { base, output } = await specs(recipe);
  return `${scrapedItemDigest('base', base.spec)}|${scrapedItemDigest('output', output.spec)}`;
}

/**
 * Whether a stored result was computed from the recipe's current requirements.
 * A result with no identity predates configurable requirements, so it was
 * necessarily computed from the authored ones; it stays valid only while the
 * recipe is still scraped with them, and is never relabelled as current.
 */
export async function scrapedResultIsCurrent(
  recipe: LoadedRecipeDefinition,
  stored: string | null,
  specs: RecipeSpecResolver,
) {
  const expected =
    stored ?? (await recipeScrapedIdentity(recipe, derivedRecipeSpecs));
  return expected === (await recipeScrapedIdentity(recipe, specs));
}
