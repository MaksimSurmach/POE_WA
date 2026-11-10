import path from 'node:path';
import { InMemoryGameDataCatalog } from '@poe-worksmith/domain';
import { loadGameDataSource } from '../gameData.js';

import { loadRecipeCatalog, RecipeCatalogError } from './loader.js';

const catalogPath = path.resolve(process.argv[2] ?? 'recipes');

try {
  const sourcePath = process.argv[3];
  const source = sourcePath ? await loadGameDataSource(sourcePath) : null;
  const gameData =
    source && new InMemoryGameDataCatalog(source.patchVersion, source);
  const recipes = await loadRecipeCatalog(catalogPath, gameData);
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
