import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  clusterJewelVariantFilter,
  mappedTargetFilter,
  RegisteredTradeQueryGenerator,
} from '@poe-worksmith/domain';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import { createV2RecipeMarketDependencies } from './recipeMarket.js';
import { loadRecipeCatalog } from './recipes/loader.js';
import { synchronizeRecipes } from './recipes/synchronizeRecipes.js';
import { createPostgresRepositories } from './repositories/index.js';
import {
  createPostgresResourceResolver,
  createPostgresTradeMappingCatalog,
  importTradeMappings,
  loadAndValidateTradeMappingManifest,
} from './tradeMappings.js';

const pool = createDatabasePool(loadDatabaseConfig());
const repositories = createPostgresRepositories(pool);
const manifestPath = fileURLToPath(
  new URL(
    '../mappings/poe-trade/3.26.0/physical-large-cluster.json',
    import.meta.url,
  ),
);
const recipesPath = fileURLToPath(new URL('../../../recipes', import.meta.url));
const metadata = {
  items: {
    result: [
      {
        entries: [
          { type: 'Large Cluster Jewel' },
          { type: 'Jagged Fossil' },
          { type: 'Primitive Chaotic Resonator' },
        ],
      },
    ],
  },
  stats: {
    result: [
      {
        entries: [
          { id: 'enchant.stat_3086156145' },
          { id: 'enchant.stat_3948993189' },
          { id: 'enchant.stat_4079888060' },
          { id: 'explicit.stat_4188581520' },
          { id: 'explicit.stat_3415827027' },
          { id: 'explicit.stat_3585232432' },
        ],
      },
    ],
  },
};

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('truncate table game_data_versions cascade');
});

describe('production catalog initialization', () => {
  it('imports the physical large cluster mappings before syncing recipes', async () => {
    const manifest = await loadAndValidateTradeMappingManifest(
      manifestPath,
      async (input) =>
        new Response(
          JSON.stringify(
            String(input).endsWith('/items') ? metadata.items : metadata.stats,
          ),
        ),
    );
    await pool.query(
      `insert into game_data_versions (game, patch_version, source, source_revision, manifest_hash, status)
       values ('poe1', '3.26.0', 'fixture', 'fixture', 'fixture', 'importing')`,
    );
    await expect(importTradeMappings(pool, manifest)).rejects.toThrow(
      'TRADE_MAPPING_VERSION_NOT_FOUND',
    );
    await pool.query(
      `update game_data_versions set status = 'active' where patch_version = '3.26.0'`,
    );
    await importTradeMappings(pool, manifest);
    const [recipe] = await loadRecipeCatalog(recipesPath);
    if (!recipe || recipe.definition.schemaVersion !== 2)
      throw new Error('Expected physical large cluster schema-v2 recipe');
    await synchronizeRecipes(repositories.recipes, [recipe], readFile);

    const dependencies = await createV2RecipeMarketDependencies({
      resolveResource: createPostgresResourceResolver(pool),
      trade: new RegisteredTradeQueryGenerator(
        createPostgresTradeMappingCatalog(pool),
        [clusterJewelVariantFilter],
        [mappedTargetFilter],
      ),
    })({ league: 'Mercenaries', recipe: recipe.definition });

    expect(dependencies).toHaveLength(4);
    expect(dependencies.map(({ kind }) => kind)).toEqual([
      'base',
      'material',
      'material',
      'target',
    ]);
  });
});
