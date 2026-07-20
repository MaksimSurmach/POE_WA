import type { Recipe, RefreshCycle } from '@poe-worksmith/domain';
import { DomainError } from '@poe-worksmith/domain';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  evaluateAndPublishCatalog,
  type FreshRecipeEvaluator,
} from './catalogPublisher.js';
import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import { createPostgresRepositories } from './repositories/postgresRepositories.js';

const pool = createDatabasePool(loadDatabaseConfig());
const repositories = createPostgresRepositories(pool);
const now = new Date('2026-07-20T00:00:00.000Z');
const leagueId = '00000000-0000-4000-8000-000000000001';

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
     values ($1, 'Standard', 'Standard', true, now())`,
    [leagueId],
  );
});

function cycle(id: string): RefreshCycle {
  return {
    completedQueries: 0,
    completedRecipes: 0,
    errorMessage: null,
    failedQueries: 0,
    failedRecipes: 0,
    finishedAt: null,
    id,
    leagueId,
    publishedAt: null,
    requestedAt: now,
    startedAt: null,
    status: 'queued',
    totalQueries: 0,
    totalRecipes: 20,
  };
}

function evaluator(failingIds: readonly string[] = []): FreshRecipeEvaluator {
  return async (recipe) => {
    if (failingIds.includes(recipe.id)) throw new DomainError('NO_LISTINGS');
    return {
      confidence: 'high',
      currency: 'chaos',
      estimatedSalePrice: '100',
      expectedCraftCost: '40',
      marginPercent: '60',
      observationId: null,
      profit: '60',
      sourceSnapshotDedupeKey: `snapshot-${recipe.id}`,
    };
  };
}

describe('catalog publication with PostgreSQL', () => {
  it('atomically publishes 95%, keeps stale fallback, and rejects 90%', async () => {
    for (let index = 1; index <= 20; index += 1) {
      const id = `recipe-${String(index).padStart(2, '0')}`;
      const recipe: Recipe = {
        active: true,
        category: 'jewel',
        contentHash: `content-${id}`,
        craftMethod: 'harvest',
        definition: {},
        gameVersion: '3.25',
        guideMarkdown: '# Guide',
        id,
        tags: ['profit'],
        title: `Recipe ${id}`,
      };
      await repositories.recipes.save(recipe);
    }

    const baselineId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await repositories.cycles.save(cycle(baselineId));
    await evaluateAndPublishCatalog(repositories, {
      cycleId: baselineId,
      evaluateRecipe: evaluator(),
      league: 'Mercenaries',
      now,
    });

    const boundaryId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await repositories.cycles.save(cycle(boundaryId));
    const boundary = await evaluateAndPublishCatalog(repositories, {
      cycleId: boundaryId,
      evaluateRecipe: evaluator(['recipe-20']),
      league: 'Mercenaries',
      now: new Date(now.getTime() + 1000),
    });
    const publishedAtBoundary = await repositories.catalog.getPublished();
    expect(boundary).toMatchObject({
      completedRecipes: 19,
      failedRecipes: 1,
      published: true,
      staleFallbacks: 1,
    });
    expect(publishedAtBoundary?.cycle.id).toBe(boundaryId);
    expect(publishedAtBoundary?.evaluations).toHaveLength(20);
    expect(
      publishedAtBoundary?.evaluations.every(
        ({ refreshCycleId }) => refreshCycleId === boundaryId,
      ),
    ).toBe(true);
    expect(
      publishedAtBoundary?.evaluations.find(
        ({ recipeId }) => recipeId === 'recipe-20',
      ),
    ).toMatchObject({ status: 'stale' });

    const rejectedId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await repositories.cycles.save(cycle(rejectedId));
    const rejected = await evaluateAndPublishCatalog(repositories, {
      cycleId: rejectedId,
      evaluateRecipe: evaluator(['recipe-19', 'recipe-20']),
      league: 'Mercenaries',
      now: new Date(now.getTime() + 2000),
    });
    const stillPublished = await repositories.catalog.getPublished();
    expect(rejected).toMatchObject({
      completedRecipes: 18,
      failedRecipes: 2,
      published: false,
    });
    expect(stillPublished?.cycle.id).toBe(boundaryId);
    expect(
      stillPublished?.evaluations.every(
        ({ refreshCycleId }) => refreshCycleId === boundaryId,
      ),
    ).toBe(true);
  });
});
