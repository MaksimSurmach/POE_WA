import { fixtureMarketDependencies } from './testkit/recipeMarket.js';
import { type JsonRecord, type Recipe } from '@poe-worksmith/domain';
import {
  canonicalRecipeFixture,
  fixtureRecipe,
} from '@poe-worksmith/domain/fixtures';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import { planCatalogRefresh as planRefresh } from './refreshPlanner.js';
import { createPostgresRepositories } from './repositories/postgresRepositories.js';

const pool = createDatabasePool(loadDatabaseConfig());
const repositories = createPostgresRepositories(pool);
const now = new Date('2026-07-20T00:00:00.000Z');
const leagueId = '00000000-0000-4000-8000-000000000001';
const refreshLeague = {
  leagueGggId: 'Mercenaries',
  leagueId,
  leagueName: 'Mercenaries',
};

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    `truncate table jobs, recipe_evaluations, raw_snapshots,
       aggregated_observations, catalog_state, market_queries,
       refresh_cycles, recipes, poe_leagues restart identity cascade`,
  );
  await pool.query(
    `insert into poe_leagues (id, ggg_id, name, is_current, synced_at)
     values ($1, 'Mercenaries', 'Mercenaries', true, now())`,
    [leagueId],
  );
});

function recipe(id: string, querySuffix: string): Recipe {
  const definition = fixtureRecipe({
    ...canonicalRecipeFixture,
    base: { ...canonicalRecipeFixture.base, baseId: `Base ${querySuffix}` },
    id,
    title: `Recipe ${querySuffix}`,
  });
  return {
    active: true,
    category: definition.category,
    contentHash: `content-${id}`,
    craftMethod: 'harvest',
    definition: { ...definition } as JsonRecord,
    gameVersion: definition.patch,
    guideMarkdown: '# Guide',
    id,
    tags: definition.tags,
    title: definition.title,
  };
}

describe('catalog refresh planner with PostgreSQL', () => {
  it('persists one cycle and job per deduplicated shared dependency', async () => {
    await repositories.recipes.save(recipe('recipe-a', 'A'));
    await repositories.recipes.save(recipe('recipe-b', 'B'));
    const options = {
      cycleId: '66666666-6666-4666-8666-666666666666',
      league: refreshLeague,
      now,
      snapshotTtlMs: 5 * 60 * 1000,
    };

    const first = await planCatalogRefresh(repositories, options);
    const repeated = await planCatalogRefresh(repositories, options);
    const counts = await pool.query<{
      jobs: string;
      queries: string;
      total_queries: number;
      total_recipes: number;
    }>(
      `select
         (select count(*) from jobs) as jobs,
         (select count(*) from market_queries) as queries,
         total_queries,
         total_recipes
       from refresh_cycles
       where id = $1`,
      [options.cycleId],
    );

    expect(first.report).toMatchObject({
      deduplicatedDependencies: 1,
      jobsEnqueued: 5,
      totalDependencies: 6,
      totalQueries: 5,
      totalRecipes: 2,
    });
    expect(repeated.report).toMatchObject({
      jobsEnqueued: 0,
      jobsReused: 5,
    });
    expect(counts.rows[0]).toEqual({
      jobs: '5',
      queries: '5',
      total_queries: 5,
      total_recipes: 2,
    });
  });
});

function planCatalogRefresh(
  repositories: Parameters<typeof planRefresh>[0],
  options: Parameters<typeof planRefresh>[1],
) {
  return planRefresh(repositories, {
    ...options,
    marketDependencies: fixtureMarketDependencies,
  });
}
