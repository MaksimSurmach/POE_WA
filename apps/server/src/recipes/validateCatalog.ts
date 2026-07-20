import path from 'node:path';

import { loadRecipeCatalog, RecipeCatalogError } from './loader.js';

const catalogPath = path.resolve(process.argv[2] ?? 'recipes');

try {
  const recipes = await loadRecipeCatalog(catalogPath);
  process.stdout.write(
    `${JSON.stringify({ catalogPath, recipes: recipes.length })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${
      error instanceof RecipeCatalogError
        ? error.message
        : 'Recipe catalog validation failed'
    }\n`,
  );
  process.exitCode = 1;
}
