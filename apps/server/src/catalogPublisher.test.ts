import { fixtureMarketDependencies } from './testkit/recipeMarket.js';
import {
  createInMemoryRepositories,
  DomainError,
  hashMarketQuery,
  type JsonRecord,
  type Recipe,
  type RefreshCycle,
  type Repositories,
} from '@poe-worksmith/domain';
import {
  canonicalRecipeFixture,
  fixtureRecipe,
} from '@poe-worksmith/domain/fixtures';
import { describe, expect, it } from 'vitest';

import {
  evaluateAndPublishCatalog,
  type FreshRecipeEvaluator,
} from './catalogPublisher.js';

const now = new Date('2026-07-20T00:00:00.000Z');
const leagueId = '00000000-0000-4000-8000-000000000001';

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
    leagueId,
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
  const currentLeague = await repositories.leagues.findCurrent();
  const league =
    currentLeague ??
    (await repositories.leagues.upsert({
      endAt: null,
      game: 'poe1',
      gggId: 'Mercenaries',
      isCurrent: true,
      metadata: {},
      name: 'Mercenaries',
      realm: 'pc',
      startAt: null,
      syncedAt: now,
    }));
  for (let index = 1; index <= recipeCount; index += 1) {
    const id = `recipe-${String(index).padStart(2, '0')}`;
    if (!(await repositories.recipes.findById(id))) {
      await repositories.recipes.save(storedRecipe(id));
    }
  }
  await repositories.cycles.save({
    ...cycle(cycleId, recipeCount),
    leagueId: league.id,
  });
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
  it('refreshes only the selected recipe and carries unrelated expired prices without re-aging them', async () => {
    const repositories = createInMemoryRepositories();
    await seedCycle(repositories, 'cycle-before-selected', 2);
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    const oldestInputAt = new Date(now.getTime() - 60_000).toISOString();
    await evaluateAndPublishCatalog(repositories, {
      cycleId: 'cycle-before-selected',
      evaluateRecipe: async (recipe, context) => ({
        ...(await evaluator()(recipe, context)),
        methodCost: { expiresAt, oldestInputAt },
      }),
      league: 'Mercenaries',
      now,
    });
    const previous = (
      await repositories.catalog.getPublished()
    )?.evaluations.find(({ recipeId }) => recipeId === 'recipe-02');
    expect(previous).toBeDefined();
    await seedCycle(repositories, 'cycle-selected', 1);
    const evaluated: string[] = [];
    const report = await evaluateAndPublishCatalog(repositories, {
      cycleId: 'cycle-selected',
      recipeId: 'recipe-01',
      evaluateRecipe: async (recipe, context) => {
        evaluated.push(recipe.id);
        if (recipe.id !== 'recipe-01')
          throw new DomainError('SNAPSHOT_EXPIRED');
        return {
          ...(await evaluator()(recipe, context)),
          estimatedSalePrice: '120',
        };
      },
      league: 'Mercenaries',
      now: new Date(now.getTime() + 31 * 60_000),
    });

    expect(evaluated).toEqual(['recipe-01']);
    expect(report).toMatchObject({
      completedRecipes: 1,
      failedRecipes: 0,
      published: true,
    });
    const published = await repositories.catalog.getPublished();
    expect(published?.cycle.id).toBe('cycle-selected');
    expect(published?.evaluations).toHaveLength(2);
    expect(
      published?.evaluations.find(({ recipeId }) => recipeId === 'recipe-01'),
    ).toMatchObject({ estimatedSalePrice: '120' });
    expect(
      published?.evaluations.find(({ recipeId }) => recipeId === 'recipe-02'),
    ).toMatchObject({
      estimatedSalePrice: previous?.estimatedSalePrice,
      evaluatedAt: previous?.evaluatedAt,
      lastSuccessfulAt: previous?.lastSuccessfulAt,
      methodCost: { expiresAt, oldestInputAt },
    });
  });

  it('refuses publication when cancellation arrives during the final recipe evaluation', async () => {
    const repositories = createInMemoryRepositories();
    await seedCycle(repositories, 'cycle-before-cancel', 1);
    await evaluateAndPublishCatalog(repositories, {
      cycleId: 'cycle-before-cancel',
      evaluateRecipe: evaluator(),
      league: 'Mercenaries',
      now,
    });
    const previous = await repositories.catalog.getPublished();
    await seedCycle(repositories, 'cycle-cancel-before-publish', 1);
    const controller = new AbortController();

    await expect(
      evaluateAndPublishCatalog(repositories, {
        cycleId: 'cycle-cancel-before-publish',
        evaluateRecipe: async (recipe, context) => {
          controller.abort();
          return evaluator()(recipe, context);
        },
        league: 'Mercenaries',
        now,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await repositories.catalog.getPublished()).toEqual(previous);
  });

  it('stops before evaluating another recipe after cancellation', async () => {
    const repositories = createInMemoryRepositories();
    await seedCycle(repositories, 'cycle-cancel-between-recipes', 2);
    const controller = new AbortController();
    const evaluated: string[] = [];

    await expect(
      evaluateAndPublishCatalog(repositories, {
        cycleId: 'cycle-cancel-between-recipes',
        evaluateRecipe: async (recipe, context) => {
          evaluated.push(recipe.id);
          controller.abort();
          return evaluator()(recipe, context);
        },
        league: 'Mercenaries',
        now,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(evaluated).toEqual(['recipe-01']);
    expect(await repositories.catalog.getPublished()).toBeNull();
  });

  it('publishes known costs when there is no output ask yet', async () => {
    const repositories = createInMemoryRepositories();
    await seedCycle(repositories, 'cycle-partial-output', 1);

    const report = await evaluateAndPublishCatalog(repositories, {
      cycleId: 'cycle-partial-output',
      evaluateRecipe: async () => ({
        confidence: 'low',
        currency: 'chaos',
        estimatedSalePrice: null,
        expectedCraftCost: '100',
        marginPercent: null,
        observationId: null,
        profit: null,
        sourceSnapshotDedupeKey: 'snapshot-recipe-01',
        status: 'partial',
      }),
      league: 'Mercenaries',
      now,
    });

    expect(report).toMatchObject({ completedRecipes: 1, published: true });
    expect(report.evaluations[0]).toMatchObject({
      estimatedSalePrice: null,
      expectedCraftCost: '100',
      lastSuccessfulAt: null,
      marginPercent: null,
      profit: null,
      status: 'partial',
    });
  });

  it('keeps a priced sale result as stale when expected craft cost is unknown', async () => {
    const repositories = createInMemoryRepositories();
    await seedCycle(repositories, 'cycle-unknown', 1);
    await evaluateAndPublishCatalog(repositories, {
      cycleId: 'cycle-unknown',
      evaluateRecipe: async () => ({
        confidence: 'low',
        currency: 'chaos',
        estimatedSalePrice: '100',
        expectedCraftCost: null,
        marginPercent: null,
        observationId: null,
        profit: null,
        sourceSnapshotDedupeKey: 'snapshot-recipe-01',
        methodCost: {
          fossil: { materialsPerAttempt: { amount: '1', currency: 'chaos' } },
        },
      }),
      league: 'Mercenaries',
      now,
    });

    await seedCycle(repositories, 'cycle-unknown-next', 1);
    const result = await evaluateAndPublishCatalog(repositories, {
      cycleId: 'cycle-unknown-next',
      evaluateRecipe: evaluator(['recipe-01']),
      league: 'Mercenaries',
      now: new Date(now.getTime() + 1000),
    });

    expect(result.evaluations[0]).toMatchObject({
      estimatedSalePrice: '100',
      expectedCraftCost: null,
      status: 'stale',
      methodCost: {
        fossil: { materialsPerAttempt: { amount: '1', currency: 'chaos' } },
      },
    });
  });

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

  it.each(['primal-crystallised-lifeforce', 'chaos-orb'])(
    'calculates a fresh recipe with %s from its persisted market snapshots',
    async (materialId) => {
      const repositories = createInMemoryRepositories();
      const definition = fixtureRecipe({
        ...canonicalRecipeFixture,
        craft: {
          ...canonicalRecipeFixture.craft,
          steps: canonicalRecipeFixture.craft.steps.map((step) => ({
            ...step,
            materials: step.materials.map((material) => ({
              ...material,
              itemId: materialId,
            })),
          })),
        },
      });
      await repositories.recipes.save(
        storedRecipe(definition.id, { ...definition } as JsonRecord),
      );
      const marketDependencies = fixtureMarketDependencies;
      const tradeQueries = (
        await marketDependencies({ recipe: definition, league: 'Mercenaries' })
      ).map(({ query }) => query);
      const league = await repositories.leagues.upsert({
        endAt: null,
        game: 'poe1',
        gggId: 'Mercenaries',
        isCurrent: true,
        metadata: {},
        name: 'Mercenaries',
        realm: 'pc',
        startAt: null,
        syncedAt: now,
      });
      const refreshCycle = {
        ...cycle('cycle-fresh', 1, tradeQueries.length),
        leagueId: league.id,
      };
      await repositories.cycles.save(refreshCycle);

      for (const [queryIndex, tradeQuery] of tradeQueries.entries()) {
        const canonicalHash = await hashMarketQuery({
          league: 'Mercenaries',
          provider: tradeQuery!.provider,
          query: tradeQuery!.query,
          schemaVersion: tradeQuery!.schemaVersion,
        });
        const marketQueryId = `query-${queryIndex}`;
        await repositories.marketQueries.save({
          active: true,
          canonicalHash,
          id: marketQueryId,
          provider: tradeQuery!.provider,
          query: tradeQuery!.query,
          recipeId: definition.id,
        });
        const startingPrices = [10, 0.01, 1000];
        const listings = Array.from({ length: 10 }, (_, listingIndex) => ({
          account: `seller-${listingIndex}`,
          ageSeconds: 60,
          fee: null,
          id: `${marketQueryId}-listing-${listingIndex}`,
          indexedAt: new Date(now.getTime() - 60_000).toISOString(),
          item: { stock: 10000 },
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
          leagueId: league.id,
          marketQueryId,
          payload: {
            coverage: 'complete',
            listings,
            provider: 'poe-trade',
            totalResults: 10,
          },
          providerStatus: 200,
          refreshCycleId: refreshCycle.id,
        });
        await repositories.observations.save({
          cheapestPrice: listings[0]!.price.amount,
          currency: 'chaos',
          leagueId,
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
        marketDependencies: fixtureMarketDependencies,
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
      if (materialId === 'chaos-orb')
        expect(report.evaluations[0]?.methodCost).toMatchObject({
          steps: [
            { materials: [{ unitPrice: { amount: '1', currency: 'chaos' } }] },
          ],
          materialEvidence: {
            'chaos-orb': { source: 'currency-unit', currency: 'chaos' },
          },
        });
    },
  );

  it('does not use stale evaluations from a previous league', async () => {
    const repositories = createInMemoryRepositories();
    await seedCycle(repositories, 'cycle-old', 1);
    await evaluateAndPublishCatalog(repositories, {
      cycleId: 'cycle-old',
      evaluateRecipe: evaluator(),
      league: 'Mercenaries',
      now,
    });
    const nextLeague = await repositories.leagues.upsert({
      endAt: null,
      game: 'poe1',
      gggId: 'Next',
      isCurrent: false,
      metadata: {},
      name: 'Next league',
      realm: 'pc',
      startAt: null,
      syncedAt: now,
    });
    await repositories.leagues.setCurrent(nextLeague.id, now);
    await seedCycle(repositories, 'cycle-new', 1);

    const report = await evaluateAndPublishCatalog(repositories, {
      cycleId: 'cycle-new',
      evaluateRecipe: evaluator(['recipe-01']),
      league: 'Next',
      now,
    });

    expect(report).toMatchObject({ published: false, staleFallbacks: 0 });
    expect(report.evaluations[0]).toMatchObject({ status: 'error' });
  });

  it('completes but does not publish when the league changes during evaluation', async () => {
    const repositories = createInMemoryRepositories();
    await seedCycle(repositories, 'cycle-rollover', 1);
    const nextLeague = await repositories.leagues.upsert({
      endAt: null,
      game: 'poe1',
      gggId: 'Next',
      isCurrent: false,
      metadata: {},
      name: 'Next league',
      realm: 'pc',
      startAt: null,
      syncedAt: now,
    });

    const report = await evaluateAndPublishCatalog(repositories, {
      cycleId: 'cycle-rollover',
      evaluateRecipe: async (recipe, context) => {
        await repositories.leagues.setCurrent(nextLeague.id, now);
        return evaluator()(recipe, context);
      },
      league: 'Mercenaries',
      now,
    });

    expect(report).toMatchObject({
      publicationDiagnostic: 'CATALOG_PUBLICATION_SKIPPED_LEAGUE_CHANGED',
      published: false,
    });
    expect(await repositories.cycles.findById('cycle-rollover')).toMatchObject({
      errorMessage: 'CATALOG_PUBLICATION_SKIPPED_LEAGUE_CHANGED',
      status: 'completed',
    });
  });
});

describe('sale evidence acceptance', () => {
  async function evaluateWithTargetSellers(
    sellers: readonly string[],
    profitBlockedReason?: string,
    coverage: 'complete' | 'partial' | 'missing' = 'complete',
    targetAsks?: readonly number[],
    budgetFixture?: {
      probabilities: readonly number[];
      quantity: number;
      baseAsk: number;
    },
  ) {
    const repositories = createInMemoryRepositories();
    const definition = fixtureRecipe(canonicalRecipeFixture);
    if (profitBlockedReason)
      definition.verification.profitBlockedReason = profitBlockedReason;
    if (budgetFixture) {
      const [roll] = definition.craft.steps;
      const evidence = definition.craft.evidence!;
      definition.craft.steps = budgetFixture.probabilities.map(
        (probability, index) => ({
          ...roll!,
          id: index === 0 ? 'roll' : 'finish',
          materials:
            budgetFixture.quantity === 0
              ? []
              : [
                  {
                    itemId: 'primal-crystallised-lifeforce',
                    quantity: budgetFixture.quantity,
                  },
                ],
          success: { evidence, probability },
        }),
      );
      definition.craft.expectedExecutions = definition.craft.steps
        .filter(({ materials }) => materials.length > 0)
        .map((step) => ({
          count: 1 / step.success!.probability,
          evidence,
          stepId: step.id,
        }));
    }
    await repositories.recipes.save(
      storedRecipe(definition.id, { ...definition } as JsonRecord),
    );
    const tradeQueries = (
      await fixtureMarketDependencies({
        recipe: definition,
        league: 'Mercenaries',
      })
    ).map(({ query }) => query!);
    const league = await repositories.leagues.upsert({
      endAt: null,
      game: 'poe1',
      gggId: 'Mercenaries',
      isCurrent: true,
      metadata: {},
      name: 'Mercenaries',
      realm: 'pc',
      startAt: null,
      syncedAt: now,
    });
    const refreshCycle = {
      ...cycle('cycle-sale-evidence', 1, tradeQueries.length),
      leagueId: league.id,
    };
    await repositories.cycles.save(refreshCycle);
    const targetIndex = tradeQueries.length - 1;
    for (const [queryIndex, tradeQuery] of tradeQueries.entries()) {
      if (coverage === 'missing' && queryIndex === targetIndex) continue;
      const marketQueryId = `query-${queryIndex}`;
      await repositories.marketQueries.save({
        active: true,
        canonicalHash: await hashMarketQuery({
          league: 'Mercenaries',
          provider: tradeQuery.provider,
          query: tradeQuery.query,
          schemaVersion: tradeQuery.schemaVersion,
        }),
        id: marketQueryId,
        provider: tradeQuery.provider,
        query: tradeQuery.query,
        recipeId: definition.id,
      });
      const accounts =
        queryIndex === targetIndex
          ? sellers
          : Array.from({ length: 10 }, (_, index) => `seller-${index}`);
      const listings = accounts.map((account, listingIndex) => ({
        account,
        ageSeconds: 60,
        fee: null,
        id: `${marketQueryId}-listing-${listingIndex}`,
        indexedAt: new Date(now.getTime() - 60_000).toISOString(),
        item: { stock: budgetFixture ? 1_000_000 : 10_000 },
        price: {
          amount: String(
            queryIndex === targetIndex
              ? (targetAsks?.[listingIndex] ?? 1000 + listingIndex)
              : (queryIndex === 0 ? (budgetFixture?.baseAsk ?? 10) : 0.01) +
                  listingIndex,
          ),
          currency: 'chaos',
        },
      }));
      await repositories.snapshots.save({
        capturedAt: now,
        dedupeKey: `snapshot-${queryIndex}`,
        expiresAt: new Date(now.getTime() + 300_000),
        leagueId: league.id,
        marketQueryId,
        payload: {
          coverage: queryIndex === targetIndex ? coverage : 'complete',
          sortedSampleComplete: coverage !== 'partial',
          listings,
          provider: 'poe-trade',
          totalResults: listings.length,
        },
        providerStatus: 200,
        refreshCycleId: refreshCycle.id,
      });
    }
    const report = await evaluateAndPublishCatalog(repositories, {
      cycleId: refreshCycle.id,
      allowMissingOutput: coverage === 'missing',
      marketDependencies: fixtureMarketDependencies,
      league: 'Mercenaries',
      now,
    });
    expect(report).toMatchObject({ completedRecipes: 1, published: true });
    return report.evaluations[0]!;
  }

  it.each([
    {
      probabilities: [0.5],
      mean: '120',
      profit: '880',
      budget: { p50: '110', p90: '140', currency: 'chaos' },
    },
    { probabilities: [0.5, 0.5], mean: '140', profit: '860', budget: null },
    {
      probabilities: [0.0016300000000000002],
      mean: '6234.96932515',
      profit: '-5234.96932515',
      budget: { p50: '4350', p90: '14220', currency: 'chaos' },
    },
    {
      probabilities: [1e-17],
      quantity: 0,
      mean: '100',
      profit: '900',
      budget: null,
    },
    {
      probabilities: [1e-9],
      quantity: 0.00010055,
      baseAsk: 1,
      mean: '1006.5',
      profit: '-6.5',
      budget: { p50: '697.9594905', p90: '2316.24931001', currency: 'chaos' },
    },
    {
      probabilities: [0.5],
      quantity: 0,
      mean: '100',
      profit: '900',
      budget: { p50: '100', p90: '100', currency: 'chaos' },
    },
  ])(
    'publishes the one-item budget for stage probabilities $probabilities and mean $mean',
    async ({ probabilities, quantity, baseAsk, mean, profit, budget }) => {
      const evaluation = await evaluateWithTargetSellers(
        ['one', 'two'],
        undefined,
        'complete',
        undefined,
        { probabilities, quantity: quantity ?? 1000, baseAsk: baseAsk ?? 100 },
      );

      expect(evaluation).toMatchObject({
        status: 'success',
        expectedCraftCost: mean,
        profit,
        methodCost: { budget },
      });
    },
  );

  it('publishes the craft cost when a scheduled output has no fresh observation', async () => {
    const evaluation = await evaluateWithTargetSellers(
      [],
      undefined,
      'missing',
    );
    expect(evaluation).toMatchObject({
      status: 'partial',
      expectedCraftCost: expect.any(String),
      estimatedSalePrice: null,
      sourceSnapshotDedupeKey: null,
      profit: null,
      methodCost: { marketStatus: 'unavailable' },
    });
  });

  it('withholds ROI from a partial output without sorted-sample proof', async () => {
    const evaluation = await evaluateWithTargetSellers(
      ['one', 'two'],
      undefined,
      'partial',
    );
    expect(evaluation).toMatchObject({
      status: 'partial',
      profit: null,
      marginPercent: null,
      methodCost: {
        saleEvidence: {
          status: 'insufficient_coverage',
          reason: expect.stringContaining('Incomplete output coverage'),
        },
      },
    });
    expect(evaluation.expectedCraftCost).not.toBeNull();
  });

  it('retains cost and asks but withholds ROI when the priced output is not the modelled craft', async () => {
    const reason = 'Observed items include an unmodelled finishing stage.';
    const evaluation = await evaluateWithTargetSellers(
      ['one', 'two', 'three', 'four', 'five'],
      reason,
    );
    expect(evaluation.expectedCraftCost).not.toBeNull();
    expect(evaluation.estimatedSalePrice).toBe('1000');
    expect(evaluation).toMatchObject({
      status: 'partial',
      profit: null,
      marginPercent: null,
      lastSuccessfulAt: null,
      methodCost: {
        saleEvidence: { status: 'unverified_output_value', reason },
      },
    });
    expect(evaluation.methodCost?.saleEvidence).not.toHaveProperty('grade');
  });

  it.each([
    ['one listing', ['lone-seller']],
    ['one seller repeating the ask', ['lone-seller', 'lone-seller']],
  ])(
    'publishes grade C profit and ROI when the sale ask rests on %s',
    async (_, sellers) => {
      const evaluation = await evaluateWithTargetSellers(sellers);

      expect(evaluation).toMatchObject({
        confidence: 'low',
        estimatedSalePrice: '1000',
        marginPercent: '5163.15789474',
        profit: '981',
        status: 'success',
        methodCost: {
          saleEvidence: {
            comparableSellers: 1,
            minimumComparableSellers: 1,
            status: 'accepted',
            grade: 'C',
            gradeReasons: ['1 seller'],
          },
        },
      });
      expect(evaluation.expectedCraftCost).not.toBeNull();
      expect(evaluation.lastSuccessfulAt).toEqual(now);
    },
  );

  it('grades complete, fresh evidence from five sellers A', async () => {
    const evaluation = await evaluateWithTargetSellers([
      'one',
      'two',
      'three',
      'four',
      'five',
    ]);
    expect(evaluation).toMatchObject({
      confidence: 'high',
      profit: '981',
      methodCost: { saleEvidence: { grade: 'A', gradeReasons: [] } },
    });
  });

  it('publishes the first comparable sale ask after a leading outlier', async () => {
    const evaluation = await evaluateWithTargetSellers(
      ['one', 'two', 'three', 'four', 'five'],
      undefined,
      'complete',
      [1, 100, 105, 110, 120],
    );

    expect(evaluation).toMatchObject({
      estimatedSalePrice: '100',
      expectedCraftCost: '19',
      profit: '81',
      methodCost: {
        saleEvidence: {
          comparableSellers: 5,
          saleBasis: 'cheapest-after-outlier',
          ignoredOutliers: 1,
          status: 'accepted',
          grade: 'B',
          gradeReasons: ['outlier ask ignored'],
        },
      },
    });
  });

  it('publishes profit and ROI once independent sellers corroborate the ask', async () => {
    const evaluation = await evaluateWithTargetSellers([
      'first-seller',
      'second-seller',
    ]);

    expect(evaluation).toMatchObject({
      estimatedSalePrice: '1000',
      status: 'success',
      methodCost: {
        saleEvidence: {
          comparableSellers: 2,
          minimumComparableSellers: 1,
          status: 'accepted',
          grade: 'B',
          gradeReasons: ['2–4 sellers'],
        },
      },
    });
    expect(Number(evaluation.marginPercent)).toBeGreaterThan(0);
    expect(Number(evaluation.profit)).toBeGreaterThan(0);
  });
});
