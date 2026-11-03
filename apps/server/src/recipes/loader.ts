import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  RecipeValidationError,
  type LoadedRecipeDefinition,
  validateRecipeDocument,
} from '@poe-worksmith/domain';

export type LoadedRecipe = {
  assets: readonly string[];
  markdown: string;
  sourcePath: string;
  definition: LoadedRecipeDefinition;
};

export type RecipeLoaderIssue = {
  file: string;
  message: string;
  path: string;
};

export class RecipeCatalogError extends Error {
  readonly issues: readonly RecipeLoaderIssue[];

  constructor(issues: readonly RecipeLoaderIssue[]) {
    const sorted = [...issues].sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.path.localeCompare(right.path) ||
        left.message.localeCompare(right.message),
    );
    super(
      `Recipe catalog validation failed:\n${sorted
        .map(
          ({ file, message, path: field }) => `- ${file}:${field}: ${message}`,
        )
        .join('\n')}`,
    );
    this.name = 'RecipeCatalogError';
    this.issues = sorted;
  }
}

export async function loadRecipeCatalog(
  catalogPath: string,
): Promise<LoadedRecipe[]> {
  const catalogRoot = path.resolve(catalogPath);
  const recipeFiles = await findRecipeFiles(catalogRoot).catch(
    (error: unknown) => {
      throw new RecipeCatalogError([
        {
          file: '.',
          message: safeErrorMessage(error),
          path: '$catalog',
        },
      ]);
    },
  );
  const loaded: LoadedRecipe[] = [];
  const issues: RecipeLoaderIssue[] = [];

  for (const recipeFile of recipeFiles) {
    try {
      loaded.push(await loadRecipeFile(recipeFile, catalogRoot));
    } catch (error) {
      if (error instanceof RecipeCatalogError) {
        issues.push(...error.issues);
      } else {
        issues.push({
          file: relativePath(catalogRoot, recipeFile),
          message: safeErrorMessage(error),
          path: '$file',
        });
      }
    }
  }

  const firstFileById = new Map<string, string>();
  for (const recipe of loaded) {
    const firstFile = firstFileById.get(recipe.definition.id);
    if (firstFile) {
      issues.push({
        file: recipe.sourcePath,
        message: `Duplicate recipe id "${recipe.definition.id}"; first defined in ${firstFile}`,
        path: 'id',
      });
    } else {
      firstFileById.set(recipe.definition.id, recipe.sourcePath);
    }
  }

  if (issues.length > 0) throw new RecipeCatalogError(issues);
  return loaded.sort(
    (left, right) =>
      left.definition.id.localeCompare(right.definition.id) ||
      left.sourcePath.localeCompare(right.sourcePath),
  );
}

export async function loadRecipeFile(
  recipeFile: string,
  catalogPath = path.dirname(recipeFile),
): Promise<LoadedRecipe> {
  const sourcePath = relativePath(
    path.resolve(catalogPath),
    path.resolve(recipeFile),
  );
  try {
    if (path.extname(recipeFile) !== '.json')
      throw new Error('Recipes must be JSON files');
    const definition = validateRecipeDocument(
      JSON.parse(await readFile(recipeFile, 'utf8')),
    );
    return { assets: [], definition, markdown: '', sourcePath };
  } catch (error) {
    throw new RecipeCatalogError(
      error instanceof RecipeValidationError
        ? error.issues.map(({ message, path }) => ({
            file: sourcePath,
            message,
            path,
          }))
        : [
            {
              file: sourcePath,
              message: safeErrorMessage(error),
              path: '$file',
            },
          ],
    );
  }
}

async function findRecipeFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await findRecipeFiles(file)));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(file);
  }
  return files.sort();
}
function relativePath(root: string, target: string) {
  return path.relative(root, target).split(path.sep).join('/');
}
function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown loader error';
}
