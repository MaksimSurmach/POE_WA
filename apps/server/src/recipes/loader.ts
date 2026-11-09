import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  canonicalCraftSetupFromRecipe,
  type CanonicalCraftMethod,
  normalizeCanonicalCraftSetup,
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
  const methodsByTarget = new Map<
    string,
    { file: string; method: CanonicalCraftMethod }[]
  >();
  for (const recipe of loaded) {
    const { definition, sourcePath: file } = recipe;
    const { craft, id, targetSignature, verification } = definition;
    const firstFile = firstFileById.get(id);
    if (firstFile) {
      issues.push({
        file,
        message: `Duplicate recipe id "${id}"; first defined in ${firstFile}`,
        path: 'id',
      });
    } else {
      firstFileById.set(id, file);
    }

    const { method } = normalizeCanonicalCraftSetup(
      canonicalCraftSetupFromRecipe(definition),
    );
    const sameTarget = methodsByTarget.get(targetSignature) ?? [];
    const duplicate = sameTarget.find((other) =>
      isDeepStrictEqual(other.method, method),
    );
    if (duplicate) {
      issues.push({
        file,
        message: `Recipe has the same target signature and craft method as ${duplicate.file}`,
        path: 'craft.method',
      });
    } else {
      sameTarget.push({ file, method });
      methodsByTarget.set(targetSignature, sameTarget);
    }

    if (verification.status !== 'verified') continue;
    if (!craft.baseConsumption) {
      issues.push({
        file,
        message: 'Verified recipe requires base consumption',
        path: 'craft.baseConsumption',
      });
    }
    for (const step of craft.steps) {
      const probability = step.success?.probability;
      const count = craft.expectedExecutions?.find(
        (e) => e.stepId === step.id,
      )?.count;
      if (count === undefined) {
        if (step.materials.length > 0 || probability !== undefined) {
          issues.push({
            file,
            message: `Missing expected execution count for step "${step.id}"`,
            path: 'craft.expectedExecutions',
          });
        }
      } else if (probability !== undefined) {
        // Multiplying by p expresses the same relative tolerance around 1/p.
        const ratio = count * probability;
        if (ratio < 0.95 || ratio > 1.05) {
          issues.push({
            file,
            message: `Step "${step.id}" execution count ${count} must be within 5% of ${1 / probability}`,
            path: 'craft.expectedExecutions',
          });
        }
      }
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
    if (entry.isDirectory() && !entry.name.startsWith('_'))
      files.push(...(await findRecipeFiles(file)));
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
