import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  JsonRecord,
  Recipe,
  RecipeRepository,
} from '@poe-worksmith/domain';

import { type LoadedRecipe, loadRecipeCatalog } from './loader.js';

export type RecipeSyncFailure = {
  id: string;
  message: string;
  operation: 'create' | 'disable' | 'hash' | 'update';
};

export type RecipeSyncReport = {
  created: string[];
  disabled: string[];
  failed: RecipeSyncFailure[];
  unchanged: string[];
  updated: string[];
};

export type ReadRecipeAsset = (assetPath: string) => Promise<Uint8Array>;

export async function computeRecipeContentHash(
  recipe: LoadedRecipe,
  readAsset: ReadRecipeAsset,
) {
  const assets = [];
  for (const assetPath of [...recipe.assets].sort()) {
    const bytes = await readAsset(assetPath);
    assets.push({ path: assetPath, sha256: sha256(bytes) });
  }

  return sha256(
    JSON.stringify(
      canonicalize({
        assets,
        definition: recipe.definition,
        markdown: recipe.markdown,
        syncFormat: 1,
      }),
    ),
  );
}

export async function synchronizeRecipes(
  repository: RecipeRepository,
  sourceRecipes: readonly LoadedRecipe[],
  readAsset: ReadRecipeAsset,
): Promise<RecipeSyncReport> {
  const report: RecipeSyncReport = {
    created: [],
    disabled: [],
    failed: [],
    unchanged: [],
    updated: [],
  };
  const existing = new Map(
    (await repository.listAll()).map((recipe) => [recipe.id, recipe]),
  );
  const sourceIds = new Set(
    sourceRecipes.map(({ definition }) => definition.id),
  );

  for (const source of [...sourceRecipes].sort((left, right) =>
    left.definition.id.localeCompare(right.definition.id),
  )) {
    const id = source.definition.id;
    const current = existing.get(id);
    let contentHash: string;
    try {
      contentHash = await computeRecipeContentHash(source, readAsset);
    } catch (error) {
      report.failed.push({
        id,
        message: errorMessage(error),
        operation: 'hash',
      });
      continue;
    }

    if (current?.active && current.contentHash === contentHash) {
      report.unchanged.push(id);
      continue;
    }

    const operation = current ? 'update' : 'create';
    try {
      await repository.save(toRecipe(source, contentHash));
      report[operation === 'create' ? 'created' : 'updated'].push(id);
    } catch (error) {
      report.failed.push({ id, message: errorMessage(error), operation });
    }
  }

  for (const current of [...existing.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (!current.active || sourceIds.has(current.id)) continue;
    try {
      await repository.save({ ...current, active: false });
      report.disabled.push(current.id);
    } catch (error) {
      report.failed.push({
        id: current.id,
        message: errorMessage(error),
        operation: 'disable',
      });
    }
  }

  return report;
}

export async function synchronizeRecipeCatalog(
  catalogPath: string,
  repository: RecipeRepository,
) {
  const catalogRoot = path.resolve(catalogPath);
  const recipes = await loadRecipeCatalog(catalogRoot);
  return synchronizeRecipes(repository, recipes, (assetPath) =>
    readFile(path.resolve(catalogRoot, assetPath)),
  );
}

function toRecipe(source: LoadedRecipe, contentHash: string): Recipe {
  const { definition } = source;
  const method = definition.craftSteps[0]?.metadata?.method;
  return {
    active: true,
    category: definition.category,
    contentHash,
    craftMethod:
      typeof method === 'string' ? method : definition.craftSteps[0]!.id,
    definition: { ...definition } as JsonRecord,
    gameVersion: definition.gameVersion,
    guideMarkdown: source.markdown,
    id: definition.id,
    tags: definition.tags,
    title: definition.title,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Unknown synchronization error';
}
