import type {
  Job,
  MarketSearchProvider,
  Recipe,
  RefreshCycle,
} from '@poe-worksmith/domain';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import { MarketJobProcessor } from './marketJobProcessor.js';
import { createPostgresRepositories } from './repositories/postgresRepositories.js';

const pool = createDatabasePool(loadDatabaseConfig());
const repositories = createPostgresRepositories(pool);
const now = new Date('2026-07-20T00:00:00.000Z');
const leaseTimeoutMs = 10_000;
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

describe('market job processor with PostgreSQL', () => {
  it('recovers a crash after provider response and commits exactly once', async () => {
    const recipe: Recipe = {
      active: true,
      category: 'jewel',
      contentHash: 'recipe-content-hash',
      craftMethod: 'harvest',
      definition: {},
      gameVersion: '3.25',
      guideMarkdown: '# Guide',
      id: 'recipe-id',
      tags: ['profit'],
      title: 'Recipe',
    };
    const cycle: RefreshCycle = {
      completedQueries: 0,
      completedRecipes: 0,
      errorMessage: null,
      failedQueries: 0,
      failedRecipes: 0,
      finishedAt: null,
      id: '77777777-7777-4777-8777-777777777777',
      leagueId,
      publishedAt: null,
      requestedAt: now,
      startedAt: now,
      status: 'running',
      totalQueries: 1,
      totalRecipes: 1,
    };
    const marketQueryId = '88888888-8888-4888-8888-888888888888';
    const job: Job = {
      attempts: 0,
      dedupeKey: `market-refresh:${cycle.id}:query-hash`,
      id: '99999999-9999-4999-8999-999999999999',
      kind: 'recipe_refresh',
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      marketQueryId,
      maxAttempts: 3,
      payload: {
        canonicalHash: 'query-hash',
        leagueGggId: 'Mercenaries',
        leagueId,
        leagueName: 'Mercenaries',
        provider: 'fake-market',
        recipeIds: [recipe.id],
        schemaVersion: 1,
      },
      priority: 10,
      recipeId: recipe.id,
      refreshCycleId: cycle.id,
      runAfter: now,
      status: 'queued',
    };
    await repositories.recipes.save(recipe);
    await repositories.cycles.save({
      ...cycle,
      startedAt: null,
      status: 'queued',
    });
    await repositories.cycles.save(cycle);
    await repositories.marketQueries.save({
      active: true,
      canonicalHash: 'query-hash',
      id: marketQueryId,
      provider: 'fake-market',
      query: { query: { type: 'Jewel' } },
      recipeId: recipe.id,
    });
    await repositories.jobs.enqueue(job);

    let calls = 0;
    const provider: MarketSearchProvider = {
      id: 'fake-market',
      async search() {
        calls += 1;
        return {
          fetchedAt: now,
          listings: [
            {
              account: 'seller',
              ageSeconds: 60,
              fee: null,
              id: 'listing',
              indexedAt: new Date(now.getTime() - 60_000),
              item: { baseType: 'Jewel' },
              price: { amount: '5', currency: 'chaos' },
            },
          ],
          provider: 'fake-market',
          totalResults: 1,
        };
      },
    };
    let clock = now;
    const createProcessor = () =>
      new MarketJobProcessor({
        clock: () => clock,
        concurrency: 1,
        leaseTimeoutMs,
        providers: [provider],
        repositories,
        retryDelayMs: 1000,
        snapshotTtlMs: 5 * 60 * 1000,
      });

    const firstWorker = createProcessor();
    const claimed = await repositories.jobs.claimNext('worker-1', now, [
      'recipe_refresh',
    ]);
    expect(claimed).not.toBeNull();
    const abandonedResult = await firstWorker.prepare(claimed!);
    const beforeRestart = await pool.query<{
      observations: string;
      snapshots: string;
    }>(
      `select
         (select count(*) from raw_snapshots) as snapshots,
         (select count(*) from aggregated_observations) as observations`,
    );
    expect(beforeRestart.rows[0]).toEqual({
      observations: '0',
      snapshots: '0',
    });

    clock = new Date(now.getTime() + leaseTimeoutMs + 1);
    const restarted = createProcessor();
    await expect(
      restarted.runAvailable('worker-2', clock),
    ).resolves.toMatchObject({
      claimed: 1,
      recovered: 1,
      succeeded: 1,
    });
    await expect(firstWorker.commit(abandonedResult)).resolves.toEqual({
      applied: false,
    });

    const persisted = await pool.query<{
      completed_queries: number;
      job_status: string;
      observations: string;
      snapshots: string;
    }>(
      `select
         (select count(*) from raw_snapshots) as snapshots,
         (select count(*) from aggregated_observations) as observations,
         (select status from jobs where id = $1) as job_status,
         completed_queries
       from refresh_cycles
       where id = $2`,
      [job.id, cycle.id],
    );
    expect(persisted.rows[0]).toEqual({
      completed_queries: 1,
      job_status: 'succeeded',
      observations: '1',
      snapshots: '1',
    });
    expect(calls).toBe(2);
  });
});
