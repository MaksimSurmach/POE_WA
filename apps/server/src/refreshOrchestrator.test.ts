import {
  createInMemoryRepositories,
  type JsonRecord,
  type MarketSearchProvider,
  type Recipe,
  validateRecipeV1,
} from '@poe-worksmith/domain';
import { validRecipeV1Fixture } from '@poe-worksmith/domain/fixtures';
import { describe, expect, it } from 'vitest';

import { MarketJobProcessor } from './marketJobProcessor.js';
import { FullRefreshOrchestrator } from './refreshOrchestrator.js';

const now = new Date('2026-07-20T00:00:00.000Z');

function storedRecipe(): Recipe {
  const definition = validateRecipeV1(validRecipeV1Fixture);
  return {
    active: true,
    category: definition.category,
    contentHash: 'content-physical-large-cluster',
    craftMethod: 'harvest',
    definition: { ...definition } as JsonRecord,
    gameVersion: definition.gameVersion,
    guideMarkdown: '# Guide',
    id: definition.id,
    tags: definition.tags,
    title: definition.title,
  };
}

describe('full refresh orchestrator', () => {
  it('plans, executes, evaluates and publishes one retry-safe cycle', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.leagues.upsert({
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
      clock: () => now,
      league: 'Mercenaries',
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
