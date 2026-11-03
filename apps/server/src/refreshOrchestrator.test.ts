import { fixtureMarketDependencies } from './testkit/recipeMarket.js';
import {
  createInMemoryRepositories,
  DomainError,
  type JsonRecord,
  type MarketSearchProvider,
  type Recipe,
} from '@poe-worksmith/domain';
import {
  canonicalRecipeFixture,
  fixtureRecipe,
} from '@poe-worksmith/domain/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarketJobProcessor } from './marketJobProcessor.js';
import { FullRefreshOrchestrator } from './refreshOrchestrator.js';
import { planCatalogRefresh } from './refreshPlanner.js';
import { evaluateAndPublishCatalog } from './catalogPublisher.js';
import { ProviderRetryPolicy } from './retryPolicy.js';

const now = new Date('2026-07-20T00:00:00.000Z');
afterEach(() => vi.restoreAllMocks());

function storedRecipe(): Recipe {
  const definition = fixtureRecipe(canonicalRecipeFixture);
  return {
    active: true,
    category: definition.category,
    contentHash: 'content-physical-large-cluster-jagged',
    craftMethod: 'harvest',
    definition: { ...definition } as JsonRecord,
    gameVersion: definition.patch,
    guideMarkdown: '# Guide',
    id: definition.id,
    tags: definition.tags,
    title: definition.title,
  };
}

describe('full refresh orchestrator', () => {
  it('plans dependencies only for the selected recipe', async () => {
    const repositories = createInMemoryRepositories();
    const league = await repositories.leagues.upsert({
      endAt: null,
      game: 'poe1',
      gggId: 'Standard',
      isCurrent: true,
      metadata: {},
      name: 'Standard',
      realm: 'pc',
      startAt: null,
      syncedAt: now,
    });
    const selected = storedRecipe();
    await repositories.recipes.save(selected);
    await repositories.recipes.save({
      ...selected,
      id: 'unrelated-invalid-recipe',
      contentHash: 'content-unrelated-invalid-recipe',
      definition: {},
    });

    const plan = await planCatalogRefresh(repositories, {
      recipeId: selected.id,
      league: {
        leagueGggId: league.gggId,
        leagueId: league.id,
        leagueName: league.name,
      },
      marketDependencies: fixtureMarketDependencies,
      snapshotTtlMs: 60_000,
      now,
    });

    expect(plan.cycle.totalRecipes).toBe(1);
    expect(plan.queries.length).toBeGreaterThan(0);
    expect(
      plan.queries.every(
        ({ recipeIds }) =>
          recipeIds.length === 1 && recipeIds[0] === selected.id,
      ),
    ).toBe(true);
  });

  it('does not replace the published catalog when cancelled during final material collection', async () => {
    const repositories = createInMemoryRepositories();
    const league = await repositories.leagues.upsert({
      endAt: null,
      game: 'poe1',
      gggId: 'Standard',
      isCurrent: true,
      metadata: {},
      name: 'Standard',
      realm: 'pc',
      startAt: null,
      syncedAt: now,
    });
    await repositories.recipes.save(storedRecipe());
    const previousId = '66666666-6666-4666-8666-666666666666';
    await repositories.cycles.save({
      id: previousId,
      leagueId: league.id,
      status: 'queued',
      totalRecipes: 1,
      totalQueries: 0,
      completedQueries: 0,
      completedRecipes: 0,
      failedQueries: 0,
      failedRecipes: 0,
      requestedAt: now,
      startedAt: null,
      finishedAt: null,
      publishedAt: null,
      errorMessage: null,
    });
    await evaluateAndPublishCatalog(repositories, {
      cycleId: previousId,
      league: league.gggId,
      now,
      evaluateRecipe: async () => ({
        confidence: 'high',
        currency: 'chaos',
        estimatedSalePrice: '100',
        expectedCraftCost: '40',
        marginPercent: '60',
        observationId: null,
        profit: '60',
        sourceSnapshotDedupeKey: null,
      }),
    });
    const previous = await repositories.catalog.getPublished();
    const controller = new AbortController();
    const id = '77777777-7777-4777-8777-777777777777';
    let collections = 0;
    const orchestrator = new FullRefreshOrchestrator({
      repositories,
      league: {
        leagueGggId: league.gggId,
        leagueId: league.id,
        leagueName: league.name,
      },
      marketDependencies: fixtureMarketDependencies,
      marketJobs: {
        runAvailable: async () => {
          const cycle = await repositories.cycles.findById(id);
          if (!cycle) throw new Error('Expected planned cycle');
          await repositories.cycles.save({
            ...cycle,
            completedQueries: cycle.totalQueries,
          });
          return {
            claimed: 0,
            failed: 0,
            recovered: 0,
            retried: 0,
            succeeded: 0,
          };
        },
      },
      collectMaterialPrices: async () => {
        if (++collections === 2) controller.abort();
      },
      clock: () => now,
      snapshotTtlMs: 60_000,
      workerId: 'test-worker',
      signal: controller.signal,
    });

    await expect(orchestrator.run(id)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(collections).toBe(2);
    expect(await repositories.catalog.getPublished()).toEqual(previous);
    expect(await repositories.evaluations.listByCycle(id)).toEqual([]);
  });

  it.each(['success', 'transient', 'long-transient', 'exhausted'] as const)(
    'finishes a cycle with provider outcome=%s',
    async (outcome) => {
      const longBatch = outcome === 'long-transient';
      let elapsedOffset = 0;
      const monotonic = performance.now.bind(performance);
      if (longBatch)
        vi.spyOn(performance, 'now').mockImplementation(
          () => monotonic() + elapsedOffset,
        );
      const started = performance.now();
      const clock = () => new Date(now.getTime() + performance.now() - started);
      const repositories = createInMemoryRepositories();
      const league = await repositories.leagues.upsert({
        endAt: null,
        game: 'poe1',
        gggId: 'Standard',
        isCurrent: true,
        metadata: {},
        name: 'Standard',
        realm: 'pc',
        startAt: null,
        syncedAt: now,
      });
      await repositories.recipes.save(storedRecipe());
      let failFirstRequest = outcome !== 'success';
      const provider: MarketSearchProvider = {
        id: 'poe-trade',
        async search(request) {
          if (failFirstRequest) {
            if (outcome !== 'exhausted') failFirstRequest = false;
            throw new DomainError('PROVIDER_UNAVAILABLE');
          }
          return {
            fetchedAt: now,
            listings: Array.from({ length: 10 }, (_, index) => ({
              account: `seller-${index}`,
              ageSeconds: 60,
              fee: null,
              id: `listing-${JSON.stringify(request.query).length}-${index}`,
              indexedAt: new Date(now.getTime() - 60_000),
              item: {},
              price: { amount: '10', currency: 'chaos' },
            })),
            provider: 'poe-trade',
            totalResults: 10,
          };
        },
      };
      const marketJobs = new MarketJobProcessor({
        clock,
        concurrency: 2,
        leaseTimeoutMs: 10_000,
        providers: [provider],
        repositories,
        retryDelayMs: 1000,
        retryPolicy: new ProviderRetryPolicy({
          baseDelayMs: 250,
          random: () => 1,
        }),
        snapshotTtlMs: longBatch ? 2 * 60 * 60_000 : 60_000,
      });
      const orchestrator = new FullRefreshOrchestrator({
        collectMaterialPrices: async () => {
          if (longBatch) elapsedOffset = 61 * 60_000;
        },
        marketDependencies: fixtureMarketDependencies,
        clock,
        league: {
          leagueGggId: league.gggId,
          leagueId: league.id,
          leagueName: league.name,
        },
        marketJobs,
        repositories,
        snapshotTtlMs: 60_000,
        maximumQuoteAgeMs: longBatch ? 2 * 60 * 60_000 : 30 * 60_000,
        workerId: 'test-worker',
      });
      const cycleId = '11111111-1111-4111-8111-111111111111';

      const first = await orchestrator.run(cycleId);
      if (outcome === 'exhausted') {
        expect(first.jobs.failed).toBe(first.plan.cacheMisses);
        expect(first.jobs.retried).toBe(first.plan.cacheMisses * 2);
        expect(first.publication.published).toBe(false);
        expect(await repositories.catalog.getPublished()).toBeNull();
        return;
      }
      const repeated = await orchestrator.run(cycleId);

      expect(first.jobs.succeeded).toBe(first.plan.cacheMisses);
      expect(first.jobs.retried).toBe(outcome === 'success' ? 0 : 1);
      expect(first.publication).toMatchObject({
        completedRecipes: 1,
        failedRecipes: 0,
        published: true,
      });
      expect(repeated).toMatchObject({
        jobs: { claimed: 0 },
        publication: { published: true, refreshCycleId: cycleId },
      });
      expect(await repositories.cycles.findById(cycleId)).toMatchObject({
        completedQueries: first.plan.totalQueries,
        status: 'published',
      });
    },
  );

  it('cancels during delayed retry backoff without another provider request or publication', async () => {
    const repositories = createInMemoryRepositories();
    const league = await repositories.leagues.upsert({
      endAt: null,
      game: 'poe1',
      gggId: 'Standard',
      isCurrent: true,
      metadata: {},
      name: 'Standard',
      realm: 'pc',
      startAt: null,
      syncedAt: now,
    });
    await repositories.recipes.save(storedRecipe());
    const controller = new AbortController();
    let batches = 0;
    const orchestrator = new FullRefreshOrchestrator({
      repositories,
      league: {
        leagueGggId: league.gggId,
        leagueId: league.id,
        leagueName: league.name,
      },
      marketDependencies: fixtureMarketDependencies,
      marketJobs: {
        runAvailable: async () => {
          batches += 1;
          setTimeout(() => controller.abort(), 10);
          return {
            claimed: 1,
            failed: 0,
            recovered: 0,
            retried: 1,
            succeeded: 0,
          };
        },
      },
      clock: () => now,
      signal: controller.signal,
      snapshotTtlMs: 60_000,
      workerId: 'cancel-retry-worker',
    });
    await expect(
      orchestrator.run('88888888-8888-4888-8888-888888888888'),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(batches).toBe(1);
    expect(await repositories.catalog.getPublished()).toBeNull();
  });
});

it('records material-source preparation failure on the durable cycle', async () => {
  const repositories = createInMemoryRepositories();
  const league = await repositories.leagues.upsert({
    game: 'poe1',
    realm: 'pc',
    gggId: 'Standard',
    name: 'Standard',
    isCurrent: true,
    endAt: null,
    startAt: null,
    syncedAt: now,
    metadata: {},
  });
  await repositories.recipes.save(storedRecipe());
  const orchestrator = new FullRefreshOrchestrator({
    repositories,
    league: {
      leagueId: league.id,
      leagueGggId: league.gggId,
      leagueName: league.name,
    },
    marketDependencies: fixtureMarketDependencies,
    marketJobs: {
      runAvailable: async () => {
        throw Error('Market dispatch must not start');
      },
    },
    collectMaterialPrices: async () => {
      throw Error('Persistence unavailable');
    },
    snapshotTtlMs: 60000,
    workerId: 'test',
    clock: () => now,
  });
  const id = '22222222-2222-4222-8222-222222222222';
  await expect(orchestrator.run(id)).rejects.toMatchObject({
    code: 'PERSISTENCE_UNAVAILABLE',
  });
  expect(await repositories.cycles.findById(id)).toMatchObject({
    status: 'failed',
    finishedAt: now,
    errorMessage: 'PERSISTENCE_UNAVAILABLE',
  });
});

it('refreshes cached material evidence again immediately before publication', async () => {
  const repositories = createInMemoryRepositories();
  const league = await repositories.leagues.upsert({
    game: 'poe1',
    realm: 'pc',
    gggId: 'Standard',
    name: 'Standard',
    isCurrent: true,
    startAt: null,
    endAt: null,
    syncedAt: now,
    metadata: {},
  });
  let clock = now;
  const collected: number[] = [];
  const orchestrator = new FullRefreshOrchestrator({
    repositories,
    league: {
      leagueId: league.id,
      leagueGggId: league.gggId,
      leagueName: league.name,
    },
    marketDependencies: fixtureMarketDependencies,
    marketJobs: {
      runAvailable: async () => {
        clock = new Date(now.getTime() + 31 * 60000);
        return {
          claimed: 0,
          failed: 0,
          recovered: 0,
          retried: 0,
          succeeded: 0,
        };
      },
    },
    collectMaterialPrices: async () => {
      collected.push(clock.getTime());
    },
    clock: () => clock,
    snapshotTtlMs: 1800000,
    workerId: 'test',
  });
  await orchestrator.run('99999999-9999-4999-8999-999999999999');
  expect(collected).toEqual([now.getTime(), now.getTime() + 31 * 60000]);
});
