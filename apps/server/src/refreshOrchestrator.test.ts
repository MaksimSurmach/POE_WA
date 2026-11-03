import { fixtureMarketDependencies } from './testkit/recipeMarket.js';
import {
  createInMemoryRepositories,
  type JsonRecord,
  type MarketSearchProvider,
  type Recipe,
} from '@poe-worksmith/domain';
import {
  canonicalRecipeFixture,
  fixtureRecipe,
} from '@poe-worksmith/domain/fixtures';
import { describe, expect, it } from 'vitest';

import { MarketJobProcessor } from './marketJobProcessor.js';
import { FullRefreshOrchestrator } from './refreshOrchestrator.js';

const now = new Date('2026-07-20T00:00:00.000Z');

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
  it('plans, executes, evaluates and publishes one retry-safe cycle', async () => {
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
    const provider: MarketSearchProvider = {
      id: 'poe-trade',
      async search(request) {
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
      concurrency: 2,
      leaseTimeoutMs: 10_000,
      providers: [provider],
      repositories,
      retryDelayMs: 1000,
      snapshotTtlMs: 60_000,
    });
    const orchestrator = new FullRefreshOrchestrator({
      marketDependencies: fixtureMarketDependencies,
      clock: () => now,
      league: {
        leagueGggId: league.gggId,
        leagueId: league.id,
        leagueName: league.name,
      },
      marketJobs,
      repositories,
      snapshotTtlMs: 60_000,
      workerId: 'test-worker',
    });
    const cycleId = '11111111-1111-4111-8111-111111111111';

    const first = await orchestrator.run(cycleId);
    const repeated = await orchestrator.run(cycleId);

    expect(first.jobs.succeeded).toBe(first.plan.cacheMisses);
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
