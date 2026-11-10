import { simulateCraftingRisk } from '@poe-worksmith/domain';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { createPostgresRepositories } from './postgresRepositories.js';
import { createCraftAnalysisRepository } from './craftAnalysisRepository.js';
import { createCraftAnalysisService } from '../craftAnalysis.js';
import { buildApi } from '../api.js';
import {
  craftAnalysisFixture,
  craftFixtureAt,
} from '../testkit/craftAnalysis.js';
import {
  canonicalRecipeFixture,
  fixtureRecipe,
} from '@poe-worksmith/domain/fixtures';
import type { CraftModelRecord } from '@poe-worksmith/contracts';

const config = loadDatabaseConfig();
const address = new URL(config.connectionString);
if (
  config.environment !== 'test' ||
  address.pathname !== '/poe_worksmith_test' ||
  !['localhost', '127.0.0.1', '[::1]', 'postgres-test'].includes(
    address.hostname,
  )
)
  throw new Error(
    'Craft analysis integration requires the isolated local poe_worksmith_test database',
  );
const pool = createDatabasePool(config);
const repositories = createPostgresRepositories(pool);
const repository = createCraftAnalysisRepository(pool);
const input = () => ({
  ...craftAnalysisFixture(),
  recipeId: 'analysis-fixture',
});
let leagueId: string;
const workerErrors: unknown[] = [];
function service(runWorker = false) {
  return createCraftAnalysisService({
    repository,
    recipes: repositories.recipes,
    leagues: repositories.leagues,
    maximumQuoteAgeMs: async () => 60_000,
    clock: () => new Date(craftFixtureAt),
    runWorker,
    onWorkerError: (error) => workerErrors.push(error),
  });
}
function simulation(model: CraftModelRecord, idempotencyKey = randomUUID()) {
  return {
    recipeId: model.recipeId,
    recipeHash: model.recipeHash,
    league: model.league,
    modelId: model.id,
    idempotencyKey,
    simulation: {
      objective: { kind: 'attempts', count: 5 },
      seed: 'reproducible-fixture',
      budget: '12',
      trials: 100,
      maxTransitions: 1000,
      reachWithinAttempts: 10,
    },
  };
}
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  workerErrors.length = 0;
  await pool.query('truncate craft_risk_runs, craft_outcome_models');
  const fixture = input();
  await repositories.recipes.save({
    id: fixture.recipeId,
    active: true,
    category: 'cluster-jewel',
    contentHash: fixture.recipeHash,
    craftMethod: 'synthetic',
    definition: {
      ...fixtureRecipe({ ...canonicalRecipeFixture, id: fixture.recipeId }),
    },
    gameVersion: 'fixture',
    guideMarkdown: '',
    title: 'Synthetic analysis recipe',
    tags: [],
  });
  const league = await repositories.leagues.upsert({
    gggId: fixture.league,
    name: fixture.league,
    game: 'poe1',
    realm: 'pc',
    startAt: null,
    endAt: null,
    isCurrent: false,
    metadata: {},
    syncedAt: new Date(craftFixtureAt),
  });
  leagueId = league.id;
  await repositories.leagues.setCurrent(league.id, new Date(craftFixtureAt));
});

describe('immutable models and durable risk runs', () => {
  it('deduplicates concurrent retries and rejects stale revision edits without rewriting history', async () => {
    const request = input();
    const app = service();
    const [first, duplicate] = await Promise.all([
      app.saveModel(request),
      app.saveModel(request),
    ]);
    expect(first.id).toBe(duplicate.id);
    const revisions = await Promise.allSettled([
      app.saveModel({
        ...request,
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
        prices: {
          ...request.prices,
          base: { ...request.prices.base!, amount: '2' },
        },
      }),
      app.saveModel({
        ...request,
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
        prices: {
          ...request.prices,
          base: { ...request.prices.base!, amount: '3' },
        },
      }),
    ]);
    expect(revisions.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = revisions.find((r) => r.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: { code: 'PERSISTENCE_CONFLICT' },
    });
    expect((await repository.findModel(first.id))?.prices.base?.amount).toBe(
      '1',
    );
    await expect(
      app.saveModel({
        ...request,
        prices: {
          ...request.prices,
          base: { ...request.prices.base!, amount: '9' },
        },
      }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
    expect(
      (
        await repository.latestModel(
          request.recipeId,
          request.recipeHash,
          leagueId,
        )
      )?.revision,
    ).toBe(2);
    expect(
      await repository.latestModel(
        request.recipeId,
        'different-revision',
        leagueId,
      ),
    ).toBeNull();
    await app.close();
  });

  it('uses only the matching current collector valuation in collector mode', async () => {
    const fixture = input();
    const captureId = randomUUID();
    const methodCost = {
      recipeContentHash: fixture.recipeHash,
      source: { captureId },
    };
    const result = {
      status: 'success',
      currency: 'chaos',
      estimatedSalePrice: '150',
      methodCost,
    };
    const collector = createCraftAnalysisRepository(pool, 'collector');
    await pool.query(
      'insert into recipe_results (recipe_id,league_id,recipe_content_hash,evaluated_at,result) values ($1,$2,$3,$4,$5)',
      [fixture.recipeId, leagueId, fixture.recipeHash, craftFixtureAt, result],
    );
    try {
      expect(await collector.readValuationCandidates(leagueId)).toMatchObject([
        {
          recipe_id: fixture.recipeId,
          recipe_content_hash: fixture.recipeHash,
          estimated_sale_price: '150',
          method_cost: methodCost,
          source_snapshot_dedupe_key: `collector:${captureId}`,
        },
      ]);
      await pool.query(
        "update recipe_results set recipe_content_hash='expired' where recipe_id=$1 and league_id=$2",
        [fixture.recipeId, leagueId],
      );
      expect(await collector.readValuationCandidates(leagueId)).toEqual([]);
    } finally {
      await pool.query(
        'delete from recipe_results where recipe_id=$1 and league_id=$2',
        [fixture.recipeId, leagueId],
      );
    }
  });

  it('runs the API through persisted inputs, repeatable simulation and cancellation', async () => {
    const app = service(true);
    const api = buildApi(
      pino({ level: 'silent' }),
      async () => {},
      async () => ({ active: null, published: null }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { craftAnalysis: app },
    );
    const headers = { host: 'localhost' };
    try {
      const saved = await api.inject({
        method: 'POST',
        url: '/api/admin/craft-analysis/models',
        headers,
        payload: input(),
      });
      expect(saved.statusCode).toBe(200);
      const model = saved.json().data as CraftModelRecord;
      const analysis = await api.inject({
        url: `/api/recipes/${model.recipeId}/analysis?league=${encodeURIComponent(model.league)}`,
        headers,
      });
      expect(analysis.statusCode).toBe(200);
      expect(analysis.json().data.analysis).toMatchObject({
        status: 'complete',
        expectedTotalCost: '2',
        expectedNetProfit: { min: '4', max: '4' },
        expectedSalvageRecovery: { min: '1', max: '1' },
      });
      const request = simulation(model);
      const [created, retried] = await Promise.all([
        api.inject({
          method: 'POST',
          url: '/api/admin/craft-analysis/simulations',
          headers,
          payload: request,
        }),
        api.inject({
          method: 'POST',
          url: '/api/admin/craft-analysis/simulations',
          headers,
          payload: request,
        }),
      ]);
      expect(created.statusCode).toBe(202);
      expect(retried.json().data.id).toBe(created.json().data.id);
      const id = created.json().data.id as string;
      await vi.waitFor(
        async () => {
          expect((await repository.findRun(id))?.status).toBe('completed');
        },
        { timeout: 5000, interval: 10 },
      );
      const completed = (await repository.findRun(id))!;
      expect(completed.result).toMatchObject({
        status: 'complete',
        dataKind: 'modelled',
        meanCost: '10',
        seed: 'reproducible-fixture',
      });
      expect(completed.request.analysis.now).toBe(craftFixtureAt);
      expect(completed.request.analysis.prices.base?.amount).toBe('1');
      const second = await app.createSimulation(simulation(model));
      await vi.waitFor(
        async () => {
          expect((await repository.findRun(second.id))?.status).toBe(
            'completed',
          );
        },
        { timeout: 5000, interval: 10 },
      );
      expect((await repository.findRun(second.id))?.result).toEqual(
        completed.result,
      );
      const read = await api.inject({
        url: `/api/admin/craft-analysis/simulations/${id}`,
        headers,
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().data.request).toEqual(completed.request);
    } finally {
      await api.close();
    }
    expect(await repository.withWorker(async () => {})).toBe(true);
    expect(workerErrors).toEqual([]);
  });

  it('persists queued cancellation and marks abandoned running work interrupted on a new worker lease', async () => {
    const app = service();
    const model = await app.saveModel(input());
    const queued = await app.createSimulation(simulation(model));
    await Promise.all([
      app.cancelSimulation(queued.id),
      app.cancelSimulation(queued.id),
    ]);
    expect(await repository.findRun(queued.id)).toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
      result: null,
    });
    const running = await app.createSimulation(simulation(model));
    await repository.withWorker(async (worker) => {
      const claimed = await worker.claim();
      expect(claimed?.id).toBe(running.id);
      const result = await simulateCraftingRisk(claimed!.request);
      await app.cancelSimulation(running.id);
      expect(await worker.progress(running.id, 99)).toBe(true);
      await worker.finish(running.id, 'completed', result, null);
    });
    expect(await repository.findRun(running.id)).toMatchObject({
      status: 'cancelled',
      result: null,
    });
    const interrupted = await app.createSimulation(simulation(model));
    await repository.withWorker(async (worker) => {
      expect((await worker.claim())?.id).toBe(interrupted.id);
    });
    await repository.withWorker(async (worker) => {
      expect(await worker.claim()).toBeNull();
    });
    expect(await repository.findRun(interrupted.id)).toMatchObject({
      status: 'interrupted',
      result: null,
      error: 'Worker interrupted before result was saved',
    });
    await app.close();
  });

  it('bounds concurrent queued work while allowing idempotent retry at capacity', async () => {
    const app = service();
    const model = await app.saveModel(input());
    const requests = Array.from({ length: 21 }, () => simulation(model));
    const results = await Promise.allSettled(
      requests.map((request) => app.createSimulation(request)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(20);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'JOB_CONFLICT' },
    });
    const index = results.findIndex((r) => r.status === 'fulfilled');
    const first = results[index]!;
    if (first.status !== 'fulfilled') throw new Error('Missing created job');
    expect((await app.createSimulation(requests[index]!)).id).toBe(
      first.value.id,
    );
    await app.close();
  });

  it('rejects recipe revision and league mismatch instead of silently reusing a model', async () => {
    const app = service();
    const model = await app.saveModel(input());
    await expect(
      app.createSimulation({
        ...simulation(model),
        recipeHash: 'other-revision',
      }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
    const another = await repositories.leagues.upsert({
      gggId: 'Other Analysis League',
      name: 'Other Analysis League',
      game: 'poe1',
      realm: 'pc',
      startAt: null,
      endAt: null,
      isCurrent: false,
      metadata: {},
      syncedAt: new Date(craftFixtureAt),
    });
    await expect(
      app.createSimulation({ ...simulation(model), league: another.gggId }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
    expect(
      (await app.readAnalysis(model.recipeId, another.gggId, true)).modelRecord,
    ).toBeNull();
    await app.close();
  });
});
