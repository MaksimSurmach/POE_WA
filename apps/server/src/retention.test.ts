import {
  createInMemoryRepositories,
  transitionRefreshCycle,
  type RefreshCycle,
} from '@poe-worksmith/domain';
import { describe, expect, it } from 'vitest';

import { RetentionCleaner } from './retention.js';

const now = new Date('2026-07-20T00:00:00.000Z');
const old = new Date('2026-06-01T00:00:00.000Z');

function queuedCycle(id: string, totalRecipes = 1): RefreshCycle {
  return {
    completedQueries: 0,
    completedRecipes: 0,
    errorMessage: null,
    failedQueries: 0,
    failedRecipes: 0,
    finishedAt: null,
    id,
    publishedAt: null,
    requestedAt: old,
    startedAt: null,
    status: 'queued',
    totalQueries: 0,
    totalRecipes,
  };
}

describe('retention cleanup', () => {
  it('drains in batches, is idempotent and protects active and published cycles', async () => {
    const repositories = createInMemoryRepositories();
    const published = queuedCycle('cycle-published');
    await repositories.cycles.save(published);
    const publishedRunning = await repositories.cycles.save({
      ...transitionRefreshCycle(published, 'running', old),
      completedRecipes: 1,
    });
    await repositories.cycles.publish(publishedRunning.id, old);

    const obsolete = queuedCycle('cycle-obsolete', 0);
    await repositories.cycles.save(obsolete);
    const obsoleteRunning = await repositories.cycles.save(
      transitionRefreshCycle(obsolete, 'running', old),
    );
    await repositories.cycles.save(
      transitionRefreshCycle(obsoleteRunning, 'failed', old, 'obsolete'),
    );

    const active = queuedCycle('cycle-active', 0);
    await repositories.cycles.save(active);
    await repositories.cycles.save(
      transitionRefreshCycle(active, 'running', old),
    );

    for (const [index, cycleId] of [
      'cycle-obsolete',
      'cycle-obsolete',
      'cycle-active',
      'cycle-published',
    ].entries()) {
      const queryId = `query-${index}`;
      await repositories.marketQueries.save({
        active: true,
        canonicalHash: `hash-${index}`,
        id: queryId,
        provider: 'fake',
        query: {},
        recipeId: 'recipe',
      });
      await repositories.snapshots.save({
        capturedAt: old,
        dedupeKey: `snapshot-${index}`,
        expiresAt: new Date(old.getTime() + 1000),
        marketQueryId: queryId,
        payload: {},
        providerStatus: 200,
        refreshCycleId: cycleId,
      });
      await repositories.observations.save({
        cheapestPrice: '1',
        currency: 'chaos',
        marketQueryId: queryId,
        medianTopNPrice: '1',
        nthPrice: null,
        observedAt: old,
        refreshCycleId: cycleId,
        sampleSize: 1,
        summary: {},
      });
      await repositories.jobs.enqueue({
        attempts: 0,
        dedupeKey: `cleanup-${index}`,
        id: `job-${index}`,
        kind: 'snapshot_cleanup',
        lastError: null,
        lockedAt: null,
        lockedBy: null,
        marketQueryId: null,
        maxAttempts: 1,
        payload: {},
        priority: 1,
        recipeId: null,
        refreshCycleId: cycleId,
        runAfter: old,
        status: 'queued',
      });
    }
    for (;;) {
      const job = await repositories.jobs.claimNext('cleanup-worker', now);
      if (!job) break;
      await repositories.jobs.complete(job.id, now);
    }

    const cleaner = new RetentionCleaner({
      batchSize: 1,
      clock: () => now,
      repositories,
    });
    const first = await cleaner.run();
    const repeated = await cleaner.run();

    expect(first).toEqual({
      batches: 3,
      drained: true,
      jobs: 2,
      observations: 2,
      rawSnapshots: 2,
    });
    expect(repeated).toEqual({
      batches: 1,
      drained: true,
      jobs: 0,
      observations: 0,
      rawSnapshots: 0,
    });
    expect(await repositories.snapshots.findLatest('query-2')).not.toBeNull();
    expect(await repositories.snapshots.findLatest('query-3')).not.toBeNull();
    expect(
      await repositories.observations.listRecent('query-2', new Date(0)),
    ).toHaveLength(1);
    expect(
      await repositories.observations.listRecent('query-3', new Date(0)),
    ).toHaveLength(1);
  });
});
