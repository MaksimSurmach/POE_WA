import type { CanonicalRecipeV1 } from './recipeSchema.js';
import { validateRecipeV1 } from './recipeSchema.js';
import type { CanonicalRecipeV2 } from './recipeSchemaV2.js';
import { validateRecipeV2 } from './recipeSchemaV2.js';

export type LoadedRecipeDefinition = CanonicalRecipeV1 | CanonicalRecipeV2;

export type RecipeDocumentMetadata = {
  category: string;
  craftMethod: string;
  gameVersion: string;
  id: string;
  tags: readonly string[];
  title: string;
};

export function validateRecipeDocument(input: unknown): LoadedRecipeDefinition {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return validateRecipeV2(input);
  }
  return (input as { schemaVersion?: unknown }).schemaVersion === 1
    ? validateRecipeV1(input)
    : validateRecipeV2(input);
}

export function recipeDocumentMetadata(
  recipe: LoadedRecipeDefinition,
): RecipeDocumentMetadata {
  if (recipe.schemaVersion === 1) {
    const method = recipe.craftSteps[0]?.metadata?.method;
    return {
      category: recipe.category,
      craftMethod:
        typeof method === 'string' ? method : recipe.craftSteps[0]!.id,
      gameVersion: recipe.gameVersion,
      id: recipe.id,
      tags: recipe.tags,
      title: recipe.title,
    };
  }
  return {
    category: recipe.category,
    craftMethod: recipe.craft.method.kind,
    gameVersion: recipe.gameDataVersion,
    id: recipe.id,
    tags: recipe.tags,
    title: recipe.title,
  };
}
