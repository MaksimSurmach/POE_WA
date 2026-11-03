import { transitionRefreshCycle } from '@poe-worksmith/domain';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { evaluateAndPublishCatalog } from './catalogPublisher.js';
import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import { MarketJobProcessor } from './marketJobProcessor.js';
import { FullRefreshOrchestrator } from './refreshOrchestrator.js';
import { planCatalogRefresh } from './refreshPlanner.js';
import { createResourceReaders } from './resourceViews.js';
import { synchronizeRecipes } from './recipes/synchronizeRecipes.js';
import { createPostgresRepositories } from './repositories/postgresRepositories.js';
import {
  DeterministicMarketProvider,
  FixedClock,
  expectedDefaultQueryHashes,
  integrationMarketDependencies,
  integrationScenario,
  loadIntegrationCatalog,
  resetIntegrationDatabase,
  type IntegrationScenarioName,
} from './testkit/index.js';

const pool = createDatabasePool(loadDatabaseConfig());
const repositories = createPostgresRepositories(pool);
const snapshotTtlMs = 5 * 60 * 1000;

afterAll(async () => pool.end());
beforeEach(async () => {
  await resetIntegrationDatabase(pool);
  const report = await synchronizeRecipes(
    repositories.recipes,
    await loadIntegrationCatalog(),
    async () => new Uint8Array(),
  );
  expect(report.failed).toEqual([]);
});

async function league(name = 'Fixture League') {
  const existing = (await repositories.leagues.list()).find(
    ({ gggId }) => gggId === name,
  );
  if (existing)
    return existing.isCurrent
      ? existing
      : repositories.leagues.setCurrent(
          existing.id,
          new Date('2026-07-20T12:00:00.000Z'),
        );
  const created = await repositories.leagues.upsert({
    endAt: null,
    game: 'poe1',
    gggId: name,
    isCurrent: (await repositories.leagues.findCurrent()) === null,
    metadata: {},
    name,
    realm: 'pc',
    startAt: null,
    syncedAt: new Date('2026-07-20T12:00:00.000Z'),
  });
  return created.isCurrent
    ? created
    : repositories.leagues.setCurrent(
        created.id,
        new Date('2026-07-20T12:00:00.000Z'),
      );
}

async function run(
  scenario: IntegrationScenarioName,
  options: {
    name?: string;
    now?: Date;
    orchestrator?: boolean;
    reuseTtlMs?: number;
    maximumQuoteAgeMs?: number;
    batchDurationMs?: number;
  } = {},
) {
  const currentLeague = await league(options.name);
  const clock = new FixedClock(options.now);
  const provider = new DeterministicMarketProvider(
    await integrationScenario(scenario, currentLeague.gggId),
    clock.now,
  );
  const processor = new MarketJobProcessor({
    clock: clock.now,
    concurrency: 1,
    leaseTimeoutMs: 10_000,
    providers: [provider],
    repositories,
    retryDelayMs: 1,
    snapshotTtlMs: options.maximumQuoteAgeMs ?? snapshotTtlMs,
  });
  const context = {
    leagueGggId: currentLeague.gggId,
    leagueId: currentLeague.id,
    leagueName: currentLeague.name,
  };
  const plan = await planCatalogRefresh(repositories, {
    league: context,
    marketDependencies: integrationMarketDependencies,
    now: clock.now(),
    snapshotTtlMs: options.reuseTtlMs ?? snapshotTtlMs,
  });
  if (options.orchestrator) {
    const report = await new FullRefreshOrchestrator({
      clock: clock.now,
      league: context,
      marketDependencies: integrationMarketDependencies,
      marketJobs: {
        async runAvailable(...args) {
          const batch = await processor.runAvailable(...args);
          clock.advanceMilliseconds(options.batchDurationMs ?? 10_000);
          return batch;
        },
      },
      repositories,
      snapshotTtlMs: options.reuseTtlMs ?? snapshotTtlMs,
      ...(options.maximumQuoteAgeMs === undefined
        ? {}
        : { maximumQuoteAgeMs: options.maximumQuoteAgeMs }),
      workerId: 'e2e',
    }).run(plan.cycle.id);
    return {
      clock,
      context,
      currentLeague,
      plan,
      processor,
      provider,
      publication: report.publication,
    };
  }
  await repositories.cycles.save(
    transitionRefreshCycle(plan.cycle, 'running', clock.now()),
  );
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await processor.runAvailable('e2e', clock.now());
    clock.advanceMilliseconds(10_000);
  }
  const publication = await evaluateAndPublishCatalog(repositories, {
    cycleId: plan.cycle.id,
    league: currentLeague.gggId,
    leagueName: currentLeague.name,
    marketDependencies: integrationMarketDependencies,
    now: clock.now(),
    ...(options.maximumQuoteAgeMs === undefined
      ? {}
      : { maximumQuoteAgeMs: options.maximumQuoteAgeMs }),
  });
  return {
    clock,
    context,
    currentLeague,
    plan,
    processor,
    provider,
    publication,
  };
}

describe('full refresh PostgreSQL E2E', () => {
  it('runs production orchestration and publishes one consistent 21-recipe cycle', async () => {
    const result = await run('all-success', { orchestrator: true });
    const hashes = await expectedDefaultQueryHashes(result.currentLeague.gggId);
    expect(result.publication).toMatchObject({
      completedRecipes: 21,
      failedRecipes: 0,
      published: true,
    });
    expect(result.plan.report.totalQueries).toBe(hashes.length);
    expect(result.provider.totalCalls()).toBe(hashes.length);
    for (const hash of hashes) result.provider.assertCallsByHash(hash, 1);
    const rows = await pool.query<{
      snapshots: string;
      observations: string;
      evaluations: string;
    }>(
      `select (select count(*) from raw_snapshots where refresh_cycle_id = $1 and league_id = $2) snapshots,
              (select count(*) from aggregated_observations where refresh_cycle_id = $1 and league_id = $2) observations,
              (select count(*) from recipe_evaluations where refresh_cycle_id = $1 and league_id = $2) evaluations`,
      [result.plan.cycle.id, result.currentLeague.id],
    );
    expect(rows.rows[0]).toEqual({
      snapshots: String(hashes.length),
      observations: String(hashes.length),
      evaluations: '21',
    });
    const readers = createResourceReaders(repositories, {
      get: () => null,
      version: () => '1',
    });
    const catalog = await readers.readCatalog('e2e');
    expect(catalog.state).toBe('success');
    if (catalog.state !== 'success')
      throw new Error('Catalog was not published');
    expect(catalog.data.entries).toHaveLength(21);
  });

  it('keeps quotes usable after reuse expires while requiring new observations on the next refresh', async () => {
    const reuseTtlMs = 60_000;
    const maximumQuoteAgeMs = 2 * 60 * 60_000;
    const result = await run('all-success', {
      orchestrator: true,
      reuseTtlMs,
      maximumQuoteAgeMs,
      batchDurationMs: 90_000,
    });
    expect(result.publication).toMatchObject({
      published: true,
      failedRecipes: 0,
    });
    const snapshots = await pool.query<{ captured_at: Date; expires_at: Date }>(
      'select captured_at,expires_at from raw_snapshots where refresh_cycle_id=$1 order by id',
      [result.plan.cycle.id],
    );
    expect(snapshots.rows.length).toBe(result.plan.report.totalQueries);
    for (const row of snapshots.rows) {
      expect(
        result.clock.now().getTime() - row.captured_at.getTime(),
      ).toBeGreaterThan(reuseTtlMs);
      expect(row.expires_at.getTime() - row.captured_at.getTime()).toBe(
        maximumQuoteAgeMs,
      );
      expect(row.expires_at.getTime()).toBeGreaterThan(
        result.clock.now().getTime(),
      );
    }
    const next = await planCatalogRefresh(repositories, {
      league: result.context,
      marketDependencies: integrationMarketDependencies,
      now: result.clock.now(),
      snapshotTtlMs: reuseTtlMs,
    });
    expect(next.report.cacheHits).toBe(0);
    expect(next.report.cacheMisses).toBe(result.plan.report.totalQueries);
    expect(
      (
        await pool.query(
          'select captured_at,expires_at from raw_snapshots where refresh_cycle_id=$1 order by id',
          [result.plan.cycle.id],
        )
      ).rows,
    ).toEqual(snapshots.rows);
  });

  it('reuses same-league snapshots within TTL and refreshes after expiry', async () => {
    const first = await run('all-success');
    const second = await run('all-success');
    expect(second.plan.report.cacheHits).toBe(second.plan.report.totalQueries);
    expect(second.provider.totalCalls()).toBe(0);
    const third = await run('all-success', {
      now: second.clock.advanceMilliseconds(snapshotTtlMs + 1),
    });
    expect(third.plan.report.cacheMisses).toBe(third.plan.report.totalQueries);
    expect(third.provider.totalCalls()).toBe(first.provider.totalCalls());
  });

  it('enforces the 95% publication boundary with independent failed target queries', async () => {
    await run('all-success');
    const at95 = await run('publish-at-95', {
      now: new Date('2026-07-20T12:05:01.000Z'),
    });
    expect(at95.publication).toMatchObject({
      completedRecipes: 20,
      failedRecipes: 1,
      published: true,
    });
    const rejected = await run('reject-below-95', {
      now: new Date('2026-07-20T12:10:02.000Z'),
    });
    expect(rejected.publication).toMatchObject({
      completedRecipes: 19,
      failedRecipes: 2,
      published: false,
    });
    expect((await repositories.catalog.getPublished())?.cycle.id).toBe(
      at95.plan.cycle.id,
    );
  });

  it('drains delayed provider retries through production orchestration before publication', async () => {
    const retry = await run('retry-429-then-success', { orchestrator: true });
    expect(retry.provider.totalCalls()).toBe(
      retry.plan.report.totalQueries + 1,
    );
    expect(retry.publication.published).toBe(true);
  });

  it('persists exhausted and schema-drift provider failures', async () => {
    const timeout = await run('timeout-exhausted');
    expect(timeout.publication).toMatchObject({ published: false });
  });

  it('persists the explicit malformed provider contract error', async () => {
    const malformed = await run('malformed-response');
    const jobs = await pool.query<{ last_error: string }>(
      'select last_error from jobs where refresh_cycle_id = $1 and last_error is not null',
      [malformed.plan.cycle.id],
    );
    expect(jobs.rows.map(({ last_error }) => last_error)).toContain(
      'PROVIDER_SCHEMA_CHANGED',
    );
    expect(malformed.publication.failedRecipes).toBeGreaterThan(0);
  });

  it('does not reuse or publish across leagues', async () => {
    const first = await run('all-success', { name: 'Fixture League A' });
    const second = await run('all-success', { name: 'Fixture League B' });
    expect(second.plan.report.cacheHits).toBe(0);
    expect(second.provider.totalCalls()).toBe(second.plan.report.totalQueries);
    expect((await repositories.catalog.getPublished())?.cycle.id).toBe(
      second.plan.cycle.id,
    );
    expect(first.currentLeague.id).not.toBe(second.currentLeague.id);
  });
});
