import {
  createInMemoryRepositories,
  DomainError,
  type MarketSearchProvider,
  type RefreshCycle,
  type Repositories,
} from '@poe-worksmith/domain';
import { describe, expect, it, vi } from 'vitest';

import { MarketJobProcessor } from './marketJobProcessor.js';

const now = new Date('2026-07-20T00:00:00.000Z');
const retryDelayMs = 1000;
const leaseTimeoutMs = 10_000;

async function seedJobs(count: number, maxAttempts = 3) {
  const repositories = createInMemoryRepositories();
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
  const queued: RefreshCycle = {
    completedQueries: 0,
    completedRecipes: 0,
    errorMessage: null,
    failedQueries: 0,
    failedRecipes: 0,
    finishedAt: null,
    id: 'cycle-id',
    leagueId: league.id,
    publishedAt: null,
    requestedAt: now,
    startedAt: null,
    status: 'queued',
    totalQueries: count,
    totalRecipes: 1,
  };
  await repositories.cycles.save(queued);
  await repositories.cycles.save({
    ...queued,
    startedAt: now,
    status: 'running',
  });

  for (let index = 0; index < count; index += 1) {
    const canonicalHash = `hash-${index}`;
    const marketQueryId = `query-${index}`;
    await repositories.marketQueries.save({
      active: true,
      canonicalHash,
      id: marketQueryId,
      provider: 'fake-market',
      query: { slot: index },
      recipeId: 'recipe-id',
    });
    await repositories.jobs.enqueue({
      attempts: 0,
      dedupeKey: `cycle:${canonicalHash}`,
      id: `job-${index}`,
      kind: 'recipe_refresh',
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      marketQueryId,
      maxAttempts,
      payload: {
        canonicalHash,
        leagueGggId: 'Mercenaries',
        leagueId: league.id,
        leagueName: 'Mercenaries',
        provider: 'fake-market',
        recipeIds: ['recipe-id'],
        schemaVersion: 1,
      },
      priority: 10,
      recipeId: 'recipe-id',
      refreshCycleId: queued.id,
      runAfter: now,
      status: 'queued',
    });
  }
  return repositories;
}

function resultProvider(
  search: MarketSearchProvider['search'],
): MarketSearchProvider {
  return { id: 'fake-market', search };
}

function successfulResult(slot = 0) {
  return {
    fetchedAt: now,
    listings: [
      {
        account: `seller-${slot}`,
        ageSeconds: 60,
        fee: null,
        id: `listing-${slot}`,
        indexedAt: new Date(now.getTime() - 60_000),
        item: { slot },
        price: { amount: String(slot + 1), currency: 'chaos' },
      },
    ],
    provider: 'fake-market',
    totalResults: 1,
  } as const;
}

function processor(
  repositories: Repositories,
  provider: MarketSearchProvider,
  clock: () => Date,
  concurrency = 2,
) {
  return new MarketJobProcessor({
    clock,
    concurrency,
    leaseTimeoutMs,
    providers: [provider],
    repositories,
    retryDelayMs,
    snapshotTtlMs: 5 * 60 * 1000,
  });
}

describe('market job processor', () => {
  it('limits concurrency and atomically advances query progress', async () => {
    const repositories = await seedJobs(4);
    let active = 0;
    let maximumActive = 0;
    const provider = resultProvider(async (request) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return successfulResult(Number(request.query.slot));
    });

    const report = await processor(
      repositories,
      provider,
      () => now,
    ).runAvailable('worker-1', now);

    expect(report).toEqual({
      claimed: 4,
      failed: 0,
      recovered: 0,
      retried: 0,
      succeeded: 4,
    });
    expect(maximumActive).toBe(2);
    expect(await repositories.cycles.findById('cycle-id')).toMatchObject({
      completedQueries: 4,
      failedQueries: 0,
    });
    for (let index = 0; index < 4; index += 1) {
      expect(
        await repositories.snapshots.findLatest(
          `query-${index}`,
          (await repositories.cycles.findById('cycle-id'))!.leagueId,
        ),
      ).not.toBeNull();
      expect(
        await repositories.observations.listRecent(
          `query-${index}`,
          (await repositories.cycles.findById('cycle-id'))!.leagueId,
          new Date(0),
        ),
      ).toHaveLength(1);
    }
  });

  it('uses the captured GGG league after the current league rolls over', async () => {
    const repositories = await seedJobs(1);
    const nextLeague = await repositories.leagues.upsert({
      endAt: null,
      game: 'poe1',
      gggId: 'Next League',
      isCurrent: false,
      metadata: {},
      name: 'Next League',
      realm: 'pc',
      startAt: now,
      syncedAt: now,
    });
    await repositories.leagues.setCurrent(nextLeague.id, now);
    const search = vi.fn(async () => successfulResult());

    await processor(
      repositories,
      resultProvider(search),
      () => now,
      1,
    ).runAvailable('worker-1', now);

    expect((await repositories.leagues.findCurrent())?.gggId).toBe(
      'Next League',
    );
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ league: 'Mercenaries' }),
    );
  });

  it('commits a repeated delivery once without duplicate observations', async () => {
    const repositories = await seedJobs(1);
    const worker = processor(
      repositories,
      resultProvider(async () => successfulResult()),
      () => now,
      1,
    );
    const job = await repositories.jobs.claimNext('worker-1', now, [
      'recipe_refresh',
    ]);
    expect(job).not.toBeNull();
    const prepared = await worker.prepare(job!);

    await expect(worker.commit(prepared)).resolves.toEqual({ applied: true });
    await expect(worker.commit(prepared)).resolves.toEqual({ applied: false });

    expect(await repositories.cycles.findById('cycle-id')).toMatchObject({
      completedQueries: 1,
    });
    expect(
      await repositories.observations.listRecent(
        'query-0',
        (await repositories.cycles.findById('cycle-id'))!.leagueId,
        new Date(0),
      ),
    ).toHaveLength(1);
  });

  it('recovers an unfinished lease after a response and completes after restart', async () => {
    const repositories = await seedJobs(1);
    let calls = 0;
    const provider = resultProvider(async () => {
      calls += 1;
      return successfulResult();
    });
    let clock = now;
    const firstWorker = processor(repositories, provider, () => clock, 1);
    const abandoned = await repositories.jobs.claimNext('worker-1', now, [
      'recipe_refresh',
    ]);
    expect(abandoned).not.toBeNull();
    await firstWorker.prepare(abandoned!);
    expect(
      await repositories.snapshots.findLatest(
        'query-0',
        (await repositories.cycles.findById('cycle-id'))!.leagueId,
      ),
    ).toBeNull();

    clock = new Date(now.getTime() + leaseTimeoutMs + 1);
    const restarted = processor(repositories, provider, () => clock, 1);
    const report = await restarted.runAvailable('worker-2', clock);

    expect(report).toMatchObject({ claimed: 1, recovered: 1, succeeded: 1 });
    expect(calls).toBe(2);
    expect(
      await repositories.snapshots.findLatest(
        'query-0',
        (await repositories.cycles.findById('cycle-id'))!.leagueId,
      ),
    ).not.toBeNull();
    expect(await repositories.cycles.findById('cycle-id')).toMatchObject({
      completedQueries: 1,
      failedQueries: 0,
    });
  });

  it('fails permanent errors immediately and retries retryable errors', async () => {
    const permanentRepositories = await seedJobs(1);
    const permanent = processor(
      permanentRepositories,
      resultProvider(async () => {
        throw new DomainError('MARKET_QUERY_INVALID');
      }),
      () => now,
      1,
    );
    expect(await permanent.runAvailable('worker-1', now)).toMatchObject({
      failed: 1,
      retried: 0,
    });
    expect(
      await permanent.runAvailable(
        'worker-1',
        new Date(now.getTime() + retryDelayMs),
      ),
    ).toMatchObject({ claimed: 0 });
    expect(
      await permanentRepositories.cycles.findById('cycle-id'),
    ).toMatchObject({ failedQueries: 1 });

    const retryRepositories = await seedJobs(1);
    let calls = 0;
    let clock = now;
    const retryable = processor(
      retryRepositories,
      resultProvider(async () => {
        calls += 1;
        if (calls === 1) throw new DomainError('PROVIDER_UNAVAILABLE');
        return successfulResult();
      }),
      () => clock,
      1,
    );
    expect(await retryable.runAvailable('worker-1', clock)).toMatchObject({
      retried: 1,
    });
    clock = new Date(now.getTime() + retryDelayMs);
    expect(await retryable.runAvailable('worker-1', clock)).toMatchObject({
      succeeded: 1,
    });
    expect(await retryRepositories.cycles.findById('cycle-id')).toMatchObject({
      completedQueries: 1,
      failedQueries: 0,
    });
  });
});
