import {
  createInMemoryRepositories,
  DomainError,
  hashMarketQuery,
  type JsonRecord,
  type Recipe,
  type RefreshCycle,
  type Repositories,
  validateRecipeV1,
} from '@poe-worksmith/domain';
import { validRecipeV1Fixture } from '@poe-worksmith/domain/fixtures';
import { describe, expect, it } from 'vitest';

import {
  evaluateAndPublishCatalog,
  type FreshRecipeEvaluator,
} from './catalogPublisher.js';

const now = new Date('2026-07-20T00:00:00.000Z');

function storedRecipe(id: string, definition: JsonRecord = {}): Recipe {
  return {
    active: true,
    category: 'jewel',
    contentHash: `content-${id}`,
    craftMethod: 'harvest',
    definition,
    gameVersion: '3.25',
    guideMarkdown: '# Guide',
    id,
    tags: ['profit'],
    title: `Recipe ${id}`,
  };
}

function cycle(
  id: string,
  totalRecipes: number,
  totalQueries = 0,
): RefreshCycle {
  return {
    completedQueries: totalQueries,
    completedRecipes: 0,
    errorMessage: null,
    failedQueries: 0,
    failedRecipes: 0,
    finishedAt: null,
    id,
    publishedAt: null,
    requestedAt: now,
    startedAt: null,
    status: 'queued',
    totalQueries,
    totalRecipes,
  };
}

async function seedCycle(
  repositories: Repositories,
  cycleId: string,
  recipeCount: number,
) {
  for (let index = 1; index <= recipeCount; index += 1) {
    const id = `recipe-${String(index).padStart(2, '0')}`;
    if (!(await repositories.recipes.findById(id))) {
      await repositories.recipes.save(storedRecipe(id));
    }
  }
  await repositories.cycles.save(cycle(cycleId, recipeCount));
}

function evaluator(failingIds: readonly string[] = []): FreshRecipeEvaluator {
  return async (recipe) => {
    if (failingIds.includes(recipe.id)) {
      throw new DomainError('NO_LISTINGS');
    }
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

describe('catalog evaluation and publication', () => {
  it('publishes at 95%, marks fallback stale, and rejects below threshold', async () => {
    const repositories = createInMemoryRepositories();
    await seedCycle(repositories, 'cycle-baseline', 20);
    await evaluateAndPublishCatalog(repositories, {
      cycleId: 'cycle-baseline',
      evaluateRecipe: evaluator(),
      league: 'Mercenaries',
      now,
    });

    await seedCycle(repositories, 'cycle-95', 20);
    const boundary = await evaluateAndPublishCatalog(repositories, {
      cycleId: 'cycle-95',
      evaluateRecipe: evaluator(['recipe-20']),
      league: 'Mercenaries',
      now: new Date(now.getTime() + 1000),
    });
    expect(boundary).toMatchObject({
      completedRecipes: 19,
      failedRecipes: 1,
      published: true,
      staleFallbacks: 1,
    });
    expect(
      boundary.evaluations.find(({ recipeId }) => recipeId === 'recipe-20'),
    ).toMatchObject({
      errorCode: 'NO_LISTINGS',
      status: 'stale',
    });

    await seedCycle(repositories, 'cycle-90', 20);
    const rejected = await evaluateAndPublishCatalog(repositories, {
      cycleId: 'cycle-90',
      evaluateRecipe: evaluator(['recipe-19', 'recipe-20']),
      league: 'Mercenaries',
      now: new Date(now.getTime() + 2000),
    });
    expect(rejected).toMatchObject({
      completedRecipes: 18,
      failedRecipes: 2,
      published: false,
      staleFallbacks: 2,
    });
    expect(await repositories.cycles.findById('cycle-90')).toMatchObject({
      status: 'failed',
    });
    const published = await repositories.catalog.getPublished();
    expect(published?.cycle.id).toBe('cycle-95');
    expect(
      published?.evaluations.every(
        ({ refreshCycleId }) => refreshCycleId === 'cycle-95',
      ),
    ).toBe(true);
  });

  it('calculates a fresh recipe from its persisted market snapshots', async () => {
    const repositories = createInMemoryRepositories();
    const definition = validateRecipeV1(validRecipeV1Fixture);
    await repositories.recipes.save(
      storedRecipe(definition.id, { ...definition } as JsonRecord),
    );
    const tradeQueries = [
      definition.baseRequirements.tradeQuery,
      ...definition.materials.map(({ tradeQuery }) => tradeQuery),
      ...definition.finishingCosts.map(({ tradeQuery }) => tradeQuery),
      definition.output.tradeQuery,
    ];
    const refreshCycle = cycle('cycle-fresh', 1, tradeQueries.length);
    await repositories.cycles.save(refreshCycle);

    for (const [queryIndex, tradeQuery] of tradeQueries.entries()) {
      const canonicalHash = await hashMarketQuery({
        league: 'Mercenaries',
        provider: tradeQuery.provider,
        query: tradeQuery.query,
        schemaVersion: tradeQuery.schemaVersion,
      });
      const marketQueryId = `query-${queryIndex}`;
      await repositories.marketQueries.save({
        active: true,
        canonicalHash,
        id: marketQueryId,
        provider: tradeQuery.provider,
        query: tradeQuery.query,
        recipeId: definition.id,
      });
      const startingPrices = [10, 0.01, 1, 1000];
      const listings = Array.from({ length: 10 }, (_, listingIndex) => ({
        account: `seller-${listingIndex}`,
        ageSeconds: 60,
        fee: null,
        id: `${marketQueryId}-listing-${listingIndex}`,
        indexedAt: new Date(now.getTime() - 60_000).toISOString(),
        item: {},
        price: {
          amount: String(
            startingPrices[queryIndex]! +
              listingIndex * (queryIndex === 1 ? 0.001 : 1),
          ),
          currency: 'chaos',
        },
      }));
      await repositories.snapshots.save({
        capturedAt: now,
        dedupeKey: `snapshot-${queryIndex}`,
        expiresAt: new Date(now.getTime() + 300_000),
        marketQueryId,
        payload: { listings, provider: 'poe-trade', totalResults: 10 },
        providerStatus: 200,
        refreshCycleId: refreshCycle.id,
      });
      await repositories.observations.save({
        cheapestPrice: listings[0]!.price.amount,
        currency: 'chaos',
        marketQueryId,
        medianTopNPrice: null,
        nthPrice: null,
        observedAt: now,
        refreshCycleId: refreshCycle.id,
        sampleSize: 10,
        summary: {},
      });
    }

    const report = await evaluateAndPublishCatalog(repositories, {
      cycleId: refreshCycle.id,
      league: 'Mercenaries',
      now,
    });

    expect(report).toMatchObject({
      completedRecipes: 1,
      failedRecipes: 0,
      published: true,
    });
    expect(report.evaluations[0]).toMatchObject({
      confidence: 'high',
      currency: 'chaos',
      errorCode: null,
      status: 'success',
    });
    expect(Number(report.evaluations[0]?.profit)).toBeGreaterThan(0);
  });
});
