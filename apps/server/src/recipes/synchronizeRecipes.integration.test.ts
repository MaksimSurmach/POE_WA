import { validateRecipeV1 } from '@poe-worksmith/domain';
import { validRecipeV1Fixture } from '@poe-worksmith/domain/fixtures';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { createPostgresRepositories } from '../repositories/index.js';
import type { LoadedRecipe } from './loader.js';
import { synchronizeRecipes } from './synchronizeRecipes.js';

const pool = createDatabasePool(loadDatabaseConfig());
const repository = createPostgresRepositories(pool).recipes;
const readAsset = async () => Buffer.from('unused');

function loadedRecipe(id = validRecipeV1Fixture.id): LoadedRecipe {
  return {
    assets: [],
    definition: validateRecipeV1({
      ...validRecipeV1Fixture,
      id,
      title: id,
    }),
    markdown: '# Guide\n',
    sourcePath: `${id}/recipe.md`,
  };
}

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    `truncate table jobs, recipe_evaluations, raw_snapshots,
       aggregated_observations, catalog_state, market_queries,
       refresh_cycles, recipes restart identity cascade`,
  );
});

describe('PostgreSQL recipe synchronization', () => {
  it('is idempotent and soft-disables removed source recipes', async () => {
    const first = loadedRecipe();
    expect(
      await synchronizeRecipes(repository, [first], readAsset),
    ).toMatchObject({
      created: [first.definition.id],
    });
    const initial = await pool.query<{
      content_hash: string;
      updated_at: Date;
    }>('select content_hash, updated_at from recipes where id = $1', [
      first.definition.id,
    ]);

    expect(
      await synchronizeRecipes(repository, [first], readAsset),
    ).toMatchObject({
      unchanged: [first.definition.id],
    });
    const unchanged = await pool.query<{
      content_hash: string;
      updated_at: Date;
    }>('select content_hash, updated_at from recipes where id = $1', [
      first.definition.id,
    ]);
    expect(unchanged.rows[0]).toEqual(initial.rows[0]);

    const changed = { ...first, markdown: '# Changed\n' };
    expect(
      await synchronizeRecipes(repository, [changed], readAsset),
    ).toMatchObject({
      updated: [first.definition.id],
    });
    const updated = await pool.query<{ content_hash: string }>(
      'select content_hash from recipes where id = $1',
      [first.definition.id],
    );
    expect(updated.rows[0]?.content_hash).not.toBe(
      initial.rows[0]?.content_hash,
    );

    const second = loadedRecipe('second-recipe');
    expect(
      await synchronizeRecipes(repository, [changed, second], readAsset),
    ).toMatchObject({ created: [second.definition.id] });
    expect(
      await synchronizeRecipes(repository, [changed], readAsset),
    ).toMatchObject({
      disabled: [second.definition.id],
    });

    expect(await repository.listAll()).toHaveLength(2);
    expect(await repository.findById(second.definition.id)).toMatchObject({
      active: false,
    });
  });
});
