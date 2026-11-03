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
import { createRecipeMarketDependencies } from './recipeMarket.js';
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
    '../mappings/poe-trade/3.29.3.3/physical-large-cluster.json',
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
          { type: 'Vivid Crystallised Lifeforce' },
          { type: 'Orb of Alteration' },
          { type: 'Orb of Transmutation' },
        ],
      },
    ],
  },
  stats: {
    result: [
      {
        entries: [
          { id: 'enchant.stat_3086156145' },
          { id: 'enchant.stat_3948993189|12' },
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
  it('imports mappings before syncing recipes and ignores archived same-patch mappings after replacement', async () => {
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
       values ('poe1', '3.29.3.3', 'fixture', 'fixture', 'fixture', 'importing')`,
    );
    await expect(importTradeMappings(pool, manifest)).rejects.toThrow(
      'TRADE_MAPPING_VERSION_NOT_FOUND',
    );
    await pool.query(
      `update game_data_versions set status = 'active' where patch_version = '3.29.3.3'`,
    );
    await importTradeMappings(pool, manifest);
    const recipes = await loadRecipeCatalog(recipesPath);
    const recipe = recipes.find(
      ({ definition }) => definition.id === 'physical-large-cluster-jagged',
    );
    if (!recipe || recipe.definition.schemaVersion !== 3)
      throw new Error('Expected physical large cluster schema-v2 recipe');
    await synchronizeRecipes(repositories.recipes, [recipe], readFile);

    const dependencies = await createRecipeMarketDependencies({
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
    expect(dependencies.map((dependency) => dependency.materialId)).toEqual([
      undefined,
      'jagged-fossil',
      'primitive-chaotic-resonator',
      undefined,
    ]);
    expect(
      dependencies
        .filter(({ kind }) => kind === 'material')
        .map(({ query }) => query?.query),
    ).toEqual([
      { exchange: { have: ['chaos'], want: ['jagged-fossil'] } },
      {
        exchange: {
          have: ['chaos'],
          want: ['primitive-chaotic-resonator'],
        },
      },
    ]);
    const alterationRecipe = recipes.find(
      ({ definition }) => definition.id === 'physical-large-cluster-alteration',
    );
    if (!alterationRecipe) throw new Error('Expected Alteration recipe');
    const alterationDependencies = await createRecipeMarketDependencies({
      resolveResource: createPostgresResourceResolver(pool),
      trade: new RegisteredTradeQueryGenerator(
        createPostgresTradeMappingCatalog(pool),
        [clusterJewelVariantFilter],
        [mappedTargetFilter],
      ),
    })({ league: 'Mercenaries', recipe: alterationRecipe.definition });
    expect(alterationDependencies.map(({ materialId }) => materialId)).toEqual([
      undefined,
      'orb-of-alteration',
      'orb-of-transmutation',
      undefined,
    ]);
    expect(
      alterationDependencies
        .filter(({ kind }) => kind === 'material')
        .map(({ query }) => query?.query),
    ).toEqual([
      { exchange: { have: ['chaos'], want: ['alt'] } },
      { exchange: { have: ['chaos'], want: ['transmute'] } },
    ]);

    await pool.query(
      "update game_data_versions set status = 'archived' where status = 'active'",
    );
    await pool.query(
      `insert into game_data_versions (game, patch_version, source, source_revision, manifest_hash, status)
       values ('poe1', '3.29.3.3', 'fixture', 'replacement', 'replacement', 'active')`,
    );
    await importTradeMappings(pool, manifest);
    const replaced = createPostgresTradeMappingCatalog(pool);
    expect(
      await replaced.resolveBase({
        baseId: recipe.definition.base.baseId,
        gameDataVersion: '3.29.3.3',
        variant: recipe.definition.base.variant,
      }),
    ).toMatchObject({ ok: true, value: { id: 'Large Cluster Jewel' } });
    expect(
      await replaced.resolveTarget({
        gameDataVersion: '3.29.3.3',
        target: {
          kind: 'explicit',
          modId: 'mod:battle-hardened',
          excluded: false,
        },
      }),
    ).toMatchObject({ ok: true, value: { id: 'explicit.stat_4188581520' } });
    expect(
      await createPostgresResourceResolver(pool)('jagged-fossil', '3.29.3.3'),
    ).toBe('jagged-fossil');
    expect(
      (
        await pool.query(
          "select count(*)::int as count from provider_mappings pm join game_data_versions gdv on gdv.id=pm.game_data_version_id where gdv.status='archived'",
        )
      ).rows[0].count,
    ).toBe(manifest.mappings.length);
  });
});
