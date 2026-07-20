import { beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryRepositories } from './inMemoryRepositories.js';
import type { Job, MarketQuery, Recipe, RefreshCycle } from './models.js';
import type { Repositories } from './repositories.js';

const recipe: Recipe = {
  active: true,
  category: 'jewel',
  contentHash: 'recipe-hash',
  craftMethod: 'harvest',
  definition: { attempts: 6 },
  gameVersion: '3.25',
  guideMarkdown: '# Craft',
  id: 'cluster-jewel',
  tags: ['physical'],
  title: 'Physical Cluster Jewel',
};

const marketQuery: MarketQuery = {
  active: true,
  canonicalHash: 'query-hash',
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'merchant',
  query: { type: 'cluster' },
  recipeId: recipe.id,
};

const cycle: RefreshCycle = {
  completedRecipes: 1,
  errorMessage: null,
  failedRecipes: 0,
  finishedAt: null,
  id: '22222222-2222-4222-8222-222222222222',
  publishedAt: null,
  requestedAt: new Date('2026-07-20T00:00:00.000Z'),
  startedAt: new Date('2026-07-20T00:00:01.000Z'),
  status: 'running',
  totalRecipes: 1,
};

const queuedCycle: RefreshCycle = {
  ...cycle,
  startedAt: null,
  status: 'queued',
};

describe('in-memory repositories', () => {
  let repositories: Repositories;

  beforeEach(() => {
    repositories = createInMemoryRepositories();
  });

  it('stores and lists active recipes', async () => {
    await repositories.recipes.save(recipe);

    expect(await repositories.recipes.findById(recipe.id)).toEqual(recipe);
    expect(await repositories.recipes.listAll()).toEqual([recipe]);
    expect(await repositories.recipes.listActive()).toEqual([recipe]);
  });

  it('deduplicates canonical market queries', async () => {
    const first = await repositories.marketQueries.save(marketQuery);
    const duplicate = await repositories.marketQueries.save({
      ...marketQuery,
      id: '33333333-3333-4333-8333-333333333333',
    });

    expect(duplicate.id).toBe(first.id);
  });

  it('deduplicates and expires raw snapshots', async () => {
    const input = {
      capturedAt: new Date('2026-07-20T00:00:00.000Z'),
      dedupeKey: 'snapshot-hash',
      expiresAt: new Date('2026-07-20T01:00:00.000Z'),
      marketQueryId: marketQuery.id,
      payload: { result: [] },
      providerStatus: 200,
      refreshCycleId: cycle.id,
    };
    const first = await repositories.snapshots.save(input);
    const duplicate = await repositories.snapshots.save(input);

    expect(first.inserted).toBe(true);
    expect(duplicate).toEqual({ inserted: false, snapshot: first.snapshot });
    expect(
      await repositories.snapshots.deleteExpired(
        new Date('2026-07-20T01:00:00.000Z'),
      ),
    ).toBe(1);
  });

  it('upserts and reads recent observations', async () => {
    const input = {
      cheapestPrice: '8.00000000',
      currency: 'divine',
      marketQueryId: marketQuery.id,
      medianTopNPrice: '8.40000000',
      nthPrice: '8.20000000',
      observedAt: new Date('2026-07-20T00:00:00.000Z'),
      refreshCycleId: cycle.id,
      sampleSize: 10,
      summary: { sellers: 8 },
    };
    const saved = await repositories.observations.save(input);

    expect(
      await repositories.observations.listRecent(
        marketQuery.id,
        new Date('2026-07-19T00:00:00.000Z'),
      ),
    ).toEqual([saved]);
  });

  it('upserts evaluations by recipe and cycle', async () => {
    const input = {
      confidence: 'medium' as const,
      errorCode: null,
      estimatedSalePrice: '8.20000000',
      evaluatedAt: new Date('2026-07-20T00:00:00.000Z'),
      expectedCraftCost: '4.10000000',
      marginPercent: '50.000000',
      observationId: null,
      profit: '4.10000000',
      recipeId: recipe.id,
      refreshCycleId: cycle.id,
      sourceSnapshotDedupeKey: 'snapshot-hash',
      status: 'success' as const,
    };
    const saved = await repositories.evaluations.save(input);

    expect(
      await repositories.evaluations.findByRecipeAndCycle(recipe.id, cycle.id),
    ).toEqual(saved);
  });

  it('publishes a complete refresh cycle atomically', async () => {
    await repositories.cycles.save(queuedCycle);
    await repositories.cycles.save(cycle);
    const publishedAt = new Date('2026-07-20T00:02:00.000Z');

    await repositories.cycles.publish(cycle.id, publishedAt);
    await repositories.cycles.publish(cycle.id, publishedAt);

    expect(await repositories.cycles.getPublishedCycleId()).toBe(cycle.id);
    expect(await repositories.cycles.findById(cycle.id)).toMatchObject({
      publishedAt,
      status: 'published',
    });
  });

  it('rejects publication of an incomplete refresh cycle', async () => {
    await repositories.cycles.save(queuedCycle);
    await repositories.cycles.save({ ...cycle, completedRecipes: 0 });

    await expect(
      repositories.cycles.publish(cycle.id, new Date()),
    ).rejects.toMatchObject({ code: 'PUBLICATION_INCOMPLETE' });
  });

  it('keeps the published catalog when a new cycle misses the threshold', async () => {
    await repositories.cycles.save(queuedCycle);
    await repositories.cycles.save(cycle);
    await repositories.cycles.publish(cycle.id, new Date());

    const nextQueued: RefreshCycle = {
      ...queuedCycle,
      id: '77777777-7777-4777-8777-777777777777',
      totalRecipes: 100,
    };
    await repositories.cycles.save(nextQueued);
    await repositories.cycles.save({
      ...nextQueued,
      completedRecipes: 94,
      failedRecipes: 6,
      startedAt: new Date(),
      status: 'running',
    });

    await expect(
      repositories.cycles.publish(nextQueued.id, new Date()),
    ).rejects.toMatchObject({ code: 'PUBLICATION_BELOW_THRESHOLD' });
    expect(await repositories.cycles.getPublishedCycleId()).toBe(cycle.id);
    expect(await repositories.cycles.findById(cycle.id)).toMatchObject({
      status: 'published',
    });
  });

  it('rejects a second running refresh cycle', async () => {
    await repositories.cycles.save(queuedCycle);
    await repositories.cycles.save(cycle);
    const secondQueued: RefreshCycle = {
      ...queuedCycle,
      id: '88888888-8888-4888-8888-888888888888',
    };
    await repositories.cycles.save(secondQueued);

    await expect(
      repositories.cycles.save({
        ...secondQueued,
        startedAt: new Date(),
        status: 'running',
      }),
    ).rejects.toMatchObject({ code: 'REFRESH_ALREADY_RUNNING' });
  });

  it('deduplicates and claims jobs in priority order', async () => {
    const now = new Date('2026-07-20T00:00:00.000Z');
    const job: Job = {
      attempts: 0,
      dedupeKey: 'job-hash',
      id: '44444444-4444-4444-8444-444444444444',
      kind: 'recipe_refresh',
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      marketQueryId: marketQuery.id,
      maxAttempts: 3,
      payload: {},
      priority: 10,
      recipeId: recipe.id,
      refreshCycleId: cycle.id,
      runAfter: now,
      status: 'queued',
    };
    await repositories.jobs.enqueue(job);
    await repositories.jobs.enqueue({ ...job, id: 'duplicate-id' });

    expect(await repositories.jobs.claimNext('worker-1', now)).toMatchObject({
      attempts: 1,
      id: job.id,
      lockedBy: 'worker-1',
      status: 'running',
    });
    expect(await repositories.jobs.claimNext('worker-2', now)).toBeNull();
  });
});
