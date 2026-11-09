import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  clusterJewelVariantFilter,
  DomainError,
  mappedTargetFilter,
  RegisteredTradeQueryGenerator,
  type Recipe,
  type RefreshCycle,
} from '@poe-worksmith/domain';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  evaluateAndPublishCatalog,
  type FreshRecipeEvaluator,
} from './catalogPublisher.js';
import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import {
  createRecipeMarketDependencies,
  recipeQueryTarget,
} from './recipeMarket.js';
import { loadRecipeCatalog } from './recipes/loader.js';
import { synchronizeRecipes } from './recipes/synchronizeRecipes.js';
import { planCatalogRefresh } from './refreshPlanner.js';
import {
  createPostgresResourceResolver,
  createPostgresTradeMappingCatalog,
  importTradeMappings,
} from './tradeMappings.js';
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
       refresh_cycles, recipes, poe_leagues, game_data_versions restart identity cascade`,
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
  it('publishes two methods from one finished-item snapshot with distinct starting-base costs', async () => {
    const catalog = await loadRecipeCatalog(
      fileURLToPath(new URL('../../../recipes', import.meta.url)),
    );
    const chaos = 'physical-large-cluster-chaos';
    const jagged = 'physical-large-cluster-jagged';
    const ids = [chaos, jagged];
    const recipes = catalog.filter(({ definition }) =>
      ids.includes(definition.id),
    );
    expect(recipes.map(({ definition }) => definition.id).sort()).toEqual(ids);
    await synchronizeRecipes(repositories.recipes, recipes, readFile);
    await pool.query(
      `insert into game_data_versions (game, patch_version, source, source_revision, manifest_hash, status)
       values ('poe1', '3.29.3.3', 'fixture', 'fixture', 'fixture', 'active')`,
    );
    for (const name of ['physical-large-cluster', 'recipe-catalog']) {
      const manifest = JSON.parse(
        await readFile(
          new URL(
            `../mappings/poe-trade/3.29.3.3/${name}.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      );
      await importTradeMappings(pool, {
        ...manifest,
        sourceRevision: manifest.mappingVersion,
      });
    }
    const marketDependencies = createRecipeMarketDependencies({
      resolveResource: createPostgresResourceResolver(pool),
      trade: new RegisteredTradeQueryGenerator(
        createPostgresTradeMappingCatalog(pool),
        [clusterJewelVariantFilter],
        [mappedTargetFilter],
      ),
    });
    const snapshotTtlMs = 30 * 60_000;
    const plan = await planCatalogRefresh(repositories, {
      league: { leagueId, leagueGggId: 'Standard', leagueName: 'Standard' },
      marketDependencies,
      now,
      snapshotTtlMs,
    });
    expect(plan.report).toMatchObject({
      totalRecipes: 2,
      totalQueries: 5,
      deduplicatedDependencies: 1,
    });
    const finishedQueries = plan.queries.filter(
      ({ marketQuery }) =>
        marketQuery.query.handbookTarget &&
        recipeQueryTarget(marketQuery.query.handbookTarget).slot ===
          'crafted-item',
    );
    expect(finishedQueries).toHaveLength(1);
    expect(finishedQueries[0]?.recipeIds).toEqual(ids);

    const clusterMods = [
      { id: 'enchant.stat_3086156145', value: 8 },
      { id: 'enchant.stat_3948993189|12', value: 12 },
      { id: 'enchant.stat_4079888060', value: 2 },
    ];
    const notableMods = [
      { id: 'explicit.stat_4188581520', value: 1 },
      { id: 'explicit.stat_3415827027', value: 1 },
      { id: 'explicit.stat_3585232432', value: 1 },
    ];
    const sharedSnapshot = 'shared-physical-cluster-output';
    for (const { marketQuery } of plan.queries) {
      const target = marketQuery.query.handbookTarget
        ? recipeQueryTarget(marketQuery.query.handbookTarget)
        : null;
      const finished = target?.slot === 'crafted-item';
      const rarity = target?.tradeSearch?.rarity ?? 'normal';
      const amount = target
        ? finished
          ? '15000'
          : rarity === 'rare'
            ? '17'
            : '10'
        : JSON.stringify(marketQuery.query.exchange).includes('jagged-fossil')
          ? '2'
          : '3';
      const listings = Array.from({ length: finished ? 5 : 1 }, (_, index) => {
        const account = `seller-${index}`;
        return {
          id: `${marketQuery.id}-${index}`,
          account,
          ageSeconds: 60,
          fee: null,
          indexedAt: now.toISOString(),
          price: { amount, currency: 'chaos' },
          item: target
            ? {
                baseType: 'Large Cluster Jewel',
                rarity,
                itemLevel: 83,
                league: 'Standard',
                patch: '3.29.3.3',
                currency: 'chaos',
                seller: account,
                status: 'listed',
                corrupted: false,
                fractured: false,
                synthesised: false,
                influences: [],
                modsComplete: true,
                mods: finished ? [...clusterMods, ...notableMods] : clusterMods,
              }
            : { stock: 1000 },
        };
      });
      await repositories.snapshots.save({
        capturedAt: now,
        dedupeKey: finished ? sharedSnapshot : marketQuery.id,
        expiresAt: new Date(now.getTime() + snapshotTtlMs),
        leagueId,
        marketQueryId: marketQuery.id,
        payload: {
          listings,
          coverage: 'complete',
          totalResults: listings.length,
        },
        providerStatus: 200,
        refreshCycleId: plan.cycle.id,
      });
    }
    await repositories.cycles.save({
      ...plan.cycle,
      completedQueries: plan.queries.length,
    });

    const report = await evaluateAndPublishCatalog(repositories, {
      cycleId: plan.cycle.id,
      league: 'Standard',
      marketDependencies,
      now,
    });
    expect(report).toMatchObject({
      published: true,
      completedRecipes: 2,
      failedRecipes: 0,
    });
    const published = await repositories.catalog.getPublished();
    expect(published?.evaluations).toHaveLength(2);
    for (const [id, base, cost, profit] of [
      [chaos, '17', 11519, 3481],
      [jagged, '10', 525, 14475],
    ] as const) {
      const evaluation = published?.evaluations.find(
        ({ recipeId }) => recipeId === id,
      );
      expect(evaluation).toMatchObject({
        status: 'success',
        sourceSnapshotDedupeKey: sharedSnapshot,
        methodCost: {
          baseCost: { amount: base, currency: 'chaos' },
          saleEvidence: { grade: 'A', comparableSellers: 5 },
        },
      });
      expect(Number(evaluation?.estimatedSalePrice)).toBe(15000);
      expect(Number(evaluation?.expectedCraftCost)).toBe(cost);
      expect(Number(evaluation?.profit)).toBe(profit);
    }
  });

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
