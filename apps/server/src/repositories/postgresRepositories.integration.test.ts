import type {
  Job,
  MarketQuery,
  Recipe,
  RefreshCycle,
} from '@poe-worksmith/domain';
import { transitionRefreshCycle } from '@poe-worksmith/domain';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { RepositoryConflictError } from './errors.js';
import { createPostgresRepositories } from './postgresRepositories.js';

const config = loadDatabaseConfig();
const pool = createDatabasePool(config);
const repositories = createPostgresRepositories(pool);
const now = new Date('2026-07-20T00:00:00.000Z');

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
  completedQueries: 1,
  completedRecipes: 1,
  errorMessage: null,
  failedQueries: 0,
  failedRecipes: 0,
  finishedAt: null,
  id: '22222222-2222-4222-8222-222222222222',
  publishedAt: null,
  requestedAt: now,
  startedAt: new Date('2026-07-20T00:00:01.000Z'),
  status: 'running',
  totalQueries: 1,
  totalRecipes: 1,
};

const queuedCycle: RefreshCycle = {
  ...cycle,
  startedAt: null,
  status: 'queued',
};

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    `truncate table jobs, recipe_evaluations, raw_snapshots,
       aggregated_observations, catalog_state, market_queries,
       refresh_cycles, recipes restart identity cascade`,
  );
});

async function seedDependencies() {
  await repositories.recipes.save(recipe);
  await repositories.cycles.save(queuedCycle);
  await repositories.cycles.save(cycle);
  await repositories.marketQueries.save(marketQuery);
}

describe('PostgreSQL repositories', () => {
  it('stores recipes and maps database conflicts', async () => {
    await repositories.recipes.save(recipe);

    expect(await repositories.recipes.findById(recipe.id)).toEqual(recipe);
    expect(await repositories.recipes.listAll()).toEqual([recipe]);
    expect(await repositories.recipes.listActive()).toEqual([recipe]);
    await expect(
      repositories.recipes.save({
        ...recipe,
        id: 'another-recipe',
      }),
    ).rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('deduplicates canonical market queries', async () => {
    await repositories.recipes.save(recipe);
    const first = await repositories.marketQueries.save(marketQuery);
    const duplicate = await repositories.marketQueries.save({
      ...marketQuery,
      id: '33333333-3333-4333-8333-333333333333',
    });

    expect(duplicate.id).toBe(first.id);
    expect(
      await repositories.marketQueries.findByCanonicalHash(
        marketQuery.canonicalHash,
      ),
    ).toEqual(first);
  });

  it('deduplicates, reads, and expires raw snapshots', async () => {
    await seedDependencies();
    const input = {
      capturedAt: now,
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
    expect(await repositories.snapshots.findLatest(marketQuery.id)).toEqual(
      first.snapshot,
    );
    expect(await repositories.snapshots.deleteExpired(input.expiresAt)).toBe(1);
  });

  it('upserts and reads recent observations', async () => {
    await seedDependencies();
    const input = {
      cheapestPrice: '8.00000000',
      currency: 'divine',
      marketQueryId: marketQuery.id,
      medianTopNPrice: '8.40000000',
      nthPrice: '8.20000000',
      observedAt: now,
      refreshCycleId: cycle.id,
      sampleSize: 10,
      summary: { sellers: 8 },
    };
    const first = await repositories.observations.save(input);
    const updated = await repositories.observations.save({
      ...input,
      sampleSize: 12,
    });

    expect(updated).toMatchObject({ id: first.id, sampleSize: 12 });
    expect(
      await repositories.observations.listRecent(
        marketQuery.id,
        new Date('2026-07-19T00:00:00.000Z'),
      ),
    ).toEqual([updated]);
  });

  it('upserts and reads recipe evaluations', async () => {
    await seedDependencies();
    const input = {
      confidence: 'medium' as const,
      currency: 'divine',
      errorCode: null,
      estimatedSalePrice: '8.20000000',
      evaluatedAt: now,
      expectedCraftCost: '4.10000000',
      lastSuccessfulAt: now,
      marginPercent: '50.000000',
      observationId: null,
      profit: '4.10000000',
      recipeId: recipe.id,
      refreshCycleId: cycle.id,
      sourceSnapshotDedupeKey: null,
      status: 'success' as const,
    };
    const first = await repositories.evaluations.save(input);
    const updated = await repositories.evaluations.save({
      ...input,
      confidence: 'high',
    });

    expect(updated).toMatchObject({ id: first.id, confidence: 'high' });
    expect(
      await repositories.evaluations.findByRecipeAndCycle(recipe.id, cycle.id),
    ).toEqual(updated);
    expect(await repositories.evaluations.listByCycle(cycle.id)).toEqual([
      updated,
    ]);
  });

  it('publishes only complete cycles and supersedes the previous cycle', async () => {
    await repositories.cycles.save(queuedCycle);
    await repositories.cycles.save({ ...cycle, completedRecipes: 0 });
    await expect(
      repositories.cycles.publish(cycle.id, now),
    ).rejects.toMatchObject({ code: 'PUBLICATION_INCOMPLETE' });

    await repositories.cycles.save(cycle);
    await repositories.cycles.publish(cycle.id, now);
    const firstPublication = await pool.query<{
      published_cycle_id: string;
      revision: string;
    }>('select published_cycle_id, revision from catalog_state where id = 1');
    await repositories.cycles.publish(cycle.id, now);
    const repeatedPublication = await pool.query<{
      published_cycle_id: string;
      revision: string;
    }>('select published_cycle_id, revision from catalog_state where id = 1');
    expect(repeatedPublication.rows[0]).toEqual(firstPublication.rows[0]);
    const nextCycle = {
      ...cycle,
      id: '55555555-5555-4555-8555-555555555555',
    };
    await repositories.cycles.save({
      ...nextCycle,
      startedAt: null,
      status: 'queued',
    });
    await repositories.cycles.save(nextCycle);
    await repositories.cycles.publish(
      nextCycle.id,
      new Date(now.getTime() + 1),
    );

    expect(await repositories.cycles.getPublishedCycleId()).toBe(nextCycle.id);
    expect(await repositories.cycles.findById(cycle.id)).toMatchObject({
      status: 'superseded',
    });
  });

  it('reads active and published progress from one catalog snapshot', async () => {
    await repositories.cycles.save(queuedCycle);
    await repositories.cycles.save(cycle);
    await repositories.cycles.publish(cycle.id, now);
    const active = {
      ...queuedCycle,
      id: '77777777-7777-4777-8777-777777777777',
      requestedAt: new Date(now.getTime() + 1000),
    };
    await repositories.cycles.save(active);

    await expect(repositories.catalog.getProgress()).resolves.toMatchObject({
      active: { id: active.id, status: 'queued' },
      published: { id: cycle.id, status: 'published' },
    });
  });

  it('rejects a second running refresh cycle', async () => {
    await repositories.cycles.save(queuedCycle);
    await repositories.cycles.save(cycle);
    const secondQueued: RefreshCycle = {
      ...queuedCycle,
      id: '99999999-9999-4999-8999-999999999999',
    };
    await repositories.cycles.save(secondQueued);

    await expect(
      repositories.cycles.save({
        ...secondQueued,
        startedAt: now,
        status: 'running',
      }),
    ).rejects.toMatchObject({ code: 'REFRESH_ALREADY_RUNNING' });
    const running = await pool.query<{ count: string }>(
      `select count(*) from refresh_cycles where status = 'running'`,
    );
    expect(running.rows[0]?.count).toBe('1');
  });

  it('keeps the published catalog when a new cycle misses the threshold', async () => {
    await repositories.cycles.save(queuedCycle);
    await repositories.cycles.save(cycle);
    await repositories.cycles.publish(cycle.id, now);

    const nextQueued: RefreshCycle = {
      ...queuedCycle,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      totalRecipes: 100,
    };
    await repositories.cycles.save(nextQueued);
    await repositories.cycles.save({
      ...nextQueued,
      completedRecipes: 94,
      failedRecipes: 6,
      startedAt: now,
      status: 'running',
    });

    await expect(
      repositories.cycles.publish(nextQueued.id, now),
    ).rejects.toMatchObject({ code: 'PUBLICATION_BELOW_THRESHOLD' });
    expect(await repositories.cycles.getPublishedCycleId()).toBe(cycle.id);
    expect(await repositories.cycles.findById(cycle.id)).toMatchObject({
      status: 'published',
    });
  });

  it('deduplicates, claims, retries, and completes jobs', async () => {
    await seedDependencies();
    const job: Job = {
      attempts: 0,
      dedupeKey: 'job-hash',
      id: '44444444-4444-4444-8444-444444444444',
      kind: 'recipe_refresh',
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      marketQueryId: marketQuery.id,
      maxAttempts: 2,
      payload: {},
      priority: 10,
      recipeId: recipe.id,
      refreshCycleId: cycle.id,
      runAfter: now,
      status: 'queued',
    };
    const first = await repositories.jobs.enqueue(job);
    const duplicate = await repositories.jobs.enqueue({
      ...job,
      id: '66666666-6666-4666-8666-666666666666',
    });

    expect(duplicate.id).toBe(first.id);
    expect(await repositories.jobs.claimNext('worker-1', now)).toMatchObject({
      attempts: 1,
      id: job.id,
      lockedBy: 'worker-1',
      status: 'running',
    });
    const retryAt = new Date(now.getTime() + 1000);
    await repositories.jobs.fail(job.id, 'temporary failure', retryAt, now);
    expect(await repositories.jobs.claimNext('worker-2', now)).toBeNull();
    await repositories.jobs.claimNext('worker-2', retryAt);
    await repositories.jobs.complete(job.id, retryAt);

    const result = await pool.query<{ status: string }>(
      'select status from jobs where id = $1',
      [job.id],
    );
    expect(result.rows[0]?.status).toBe('succeeded');
  });

  it('cleans one old batch and protects active and published cycle data', async () => {
    const old = new Date('2026-06-01T00:00:00.000Z');
    await repositories.recipes.save(recipe);
    await repositories.marketQueries.save(marketQuery);

    await repositories.cycles.save(queuedCycle);
    await repositories.cycles.save(cycle);
    await repositories.cycles.publish(cycle.id, now);
    const obsoleteQueued = {
      ...queuedCycle,
      completedQueries: 0,
      completedRecipes: 0,
      id: '88888888-8888-4888-8888-888888888888',
      requestedAt: old,
      totalQueries: 0,
      totalRecipes: 0,
    };
    await repositories.cycles.save(obsoleteQueued);
    const obsoleteRunning = await repositories.cycles.save(
      transitionRefreshCycle(obsoleteQueued, 'running', old),
    );
    await repositories.cycles.save(
      transitionRefreshCycle(obsoleteRunning, 'failed', old, 'obsolete'),
    );
    const activeQueued = {
      ...obsoleteQueued,
      id: '99999999-9999-4999-8999-999999999999',
    };
    await repositories.cycles.save(activeQueued);
    await repositories.cycles.save(
      transitionRefreshCycle(activeQueued, 'running', old),
    );

    for (const [index, cycleId] of [
      obsoleteQueued.id,
      activeQueued.id,
      cycle.id,
    ].entries()) {
      await repositories.snapshots.save({
        capturedAt: old,
        dedupeKey: `retention-snapshot-${index}`,
        expiresAt: new Date(old.getTime() + 60_000),
        marketQueryId: marketQuery.id,
        payload: {},
        providerStatus: 200,
        refreshCycleId: cycleId,
      });
      await repositories.observations.save({
        cheapestPrice: '1',
        currency: 'chaos',
        marketQueryId: marketQuery.id,
        medianTopNPrice: '1',
        nthPrice: null,
        observedAt: old,
        refreshCycleId: cycleId,
        sampleSize: 1,
        summary: {},
      });
      const jobId = `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`;
      await repositories.jobs.enqueue({
        attempts: 0,
        dedupeKey: `retention-job-${index}`,
        id: jobId,
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
      await pool.query(
        `update jobs set status = 'succeeded', updated_at = $2 where id = $1`,
        [jobId, old],
      );
    }

    const options = {
      batchSize: 1,
      jobsBefore: now,
      observationsBefore: now,
      rawSnapshotsBefore: now,
    };
    await expect(repositories.retention.cleanup(options)).resolves.toEqual({
      jobs: 1,
      observations: 1,
      rawSnapshots: 1,
    });
    await expect(repositories.retention.cleanup(options)).resolves.toEqual({
      jobs: 0,
      observations: 0,
      rawSnapshots: 0,
    });
    const protectedRows = await pool.query<{ refresh_cycle_id: string }>(
      `select refresh_cycle_id from raw_snapshots order by refresh_cycle_id`,
    );
    expect(protectedRows.rows.map((row) => row.refresh_cycle_id)).toEqual([
      cycle.id,
      activeQueued.id,
    ]);
  });
});
