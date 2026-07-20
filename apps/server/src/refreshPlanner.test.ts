import {
  createInMemoryRepositories,
  type JsonRecord,
  type Recipe,
  validateRecipeV1,
} from '@poe-worksmith/domain';
import { validRecipeV1Fixture } from '@poe-worksmith/domain/fixtures';
import { describe, expect, it, vi } from 'vitest';

import { planCatalogRefresh } from './refreshPlanner.js';

const now = new Date('2026-07-20T00:00:00.000Z');
const snapshotTtlMs = 5 * 60 * 1000;
const refreshLeague = {
  leagueGggId: 'Mercenaries',
  leagueId: '00000000-0000-4000-8000-000000000001',
  leagueName: 'Mercenaries',
};

async function seedCurrentLeague(
  repositories: ReturnType<typeof createInMemoryRepositories>,
) {
  return repositories.leagues.upsert({
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
}

function recipe(id: string, querySuffix: string): Recipe {
  const definition = validateRecipeV1({
    ...validRecipeV1Fixture,
    baseRequirements: {
      ...validRecipeV1Fixture.baseRequirements,
      tradeQuery: {
        ...validRecipeV1Fixture.baseRequirements.tradeQuery,
        query: { query: { type: `Base ${querySuffix}` } },
      },
    },
    finishingCosts: [],
    id,
    output: {
      ...validRecipeV1Fixture.output,
      tradeQuery: {
        ...validRecipeV1Fixture.output.tradeQuery,
        query: { query: { type: `Output ${querySuffix}` } },
      },
    },
    title: `Recipe ${querySuffix}`,
  });

  return {
    active: true,
    category: definition.category,
    contentHash: `content-${id}`,
    craftMethod: 'harvest',
    definition: { ...definition } as JsonRecord,
    gameVersion: definition.gameVersion,
    guideMarkdown: '# Guide',
    id,
    tags: definition.tags,
    title: definition.title,
  };
}

async function repositoriesWithSharedMaterial() {
  const repositories = createInMemoryRepositories();
  await seedCurrentLeague(repositories);
  await repositories.recipes.save(recipe('recipe-a', 'A'));
  await repositories.recipes.save(recipe('recipe-b', 'B'));
  return repositories;
}

describe('catalog refresh planner', () => {
  it('uses only the captured league context', async () => {
    const repositories = await repositoriesWithSharedMaterial();
    const findCurrent = vi
      .spyOn(repositories.leagues, 'findCurrent')
      .mockRejectedValue(new Error('unexpected league lookup'));

    const plan = await planCatalogRefresh(repositories, {
      cycleId: '00000000-0000-4000-8000-000000000002',
      league: refreshLeague,
      now,
      snapshotTtlMs,
    });

    expect(findCurrent).not.toHaveBeenCalled();
    expect(plan.cycle.leagueId).toBe(refreshLeague.leagueId);
    expect(plan.queries[0]?.job?.payload).toMatchObject(refreshLeague);
  });

  it('deduplicates shared dependencies and is idempotent within a cycle', async () => {
    const repositories = await repositoriesWithSharedMaterial();
    const options = {
      cycleId: '11111111-1111-4111-8111-111111111111',
      league: refreshLeague,
      now,
      snapshotTtlMs,
    };

    const first = await planCatalogRefresh(repositories, options);
    const repeated = await planCatalogRefresh(repositories, options);

    expect(first.report).toEqual({
      cacheHits: 0,
      cacheMisses: 5,
      deduplicatedDependencies: 1,
      jobsEnqueued: 5,
      jobsReused: 0,
      totalDependencies: 6,
      totalQueries: 5,
      totalRecipes: 2,
    });
    expect(
      first.queries.filter(({ recipeIds }) => recipeIds.length === 2),
    ).toHaveLength(1);
    expect(repeated.report).toMatchObject({
      cacheMisses: 5,
      jobsEnqueued: 0,
      jobsReused: 5,
    });
    expect(repeated.queries.map(({ job }) => job?.id)).toEqual(
      first.queries.map(({ job }) => job?.id),
    );
    expect(await repositories.cycles.findById(options.cycleId)).toMatchObject({
      totalQueries: 5,
      totalRecipes: 2,
    });

    const claimed = [];
    for (;;) {
      const job = await repositories.jobs.claimNext('worker', now);
      if (!job) break;
      claimed.push(job);
    }
    expect(claimed).toHaveLength(5);
  });

  it('uses every fresh snapshot and enqueues no market jobs', async () => {
    const repositories = await repositoriesWithSharedMaterial();
    const first = await planCatalogRefresh(repositories, {
      cycleId: '22222222-2222-4222-8222-222222222222',
      league: refreshLeague,
      now,
      snapshotTtlMs,
    });
    for (const query of first.queries) {
      await repositories.snapshots.save({
        capturedAt: new Date(now.getTime() - 60_000),
        dedupeKey: `snapshot:${query.canonicalHash}`,
        expiresAt: new Date(now.getTime() + snapshotTtlMs - 60_000),
        leagueId: first.cycle.leagueId,
        marketQueryId: query.marketQuery.id,
        payload: {},
        providerStatus: 200,
        refreshCycleId: first.cycle.id,
      });
    }

    const cached = await planCatalogRefresh(repositories, {
      cycleId: '33333333-3333-4333-8333-333333333333',
      league: refreshLeague,
      now,
      snapshotTtlMs,
    });

    expect(cached.report).toMatchObject({
      cacheHits: 5,
      cacheMisses: 0,
      jobsEnqueued: 0,
      jobsReused: 0,
    });
    expect(cached.queries.every(({ job }) => job === null)).toBe(true);
    expect(await repositories.cycles.findById(cached.cycle.id)).toMatchObject({
      completedQueries: 5,
      failedQueries: 0,
      totalQueries: 5,
    });
  });

  it('does not reuse a snapshot from another league with the same query hash', async () => {
    const repositories = await repositoriesWithSharedMaterial();
    const first = await planCatalogRefresh(repositories, {
      cycleId: '66666666-6666-4666-8666-666666666666',
      league: refreshLeague,
      now,
      snapshotTtlMs,
    });
    for (const query of first.queries) {
      await repositories.snapshots.save({
        capturedAt: now,
        dedupeKey: `league-one:${query.canonicalHash}`,
        expiresAt: new Date(now.getTime() + snapshotTtlMs),
        leagueId: first.cycle.leagueId,
        marketQueryId: query.marketQuery.id,
        payload: {},
        providerStatus: 200,
        refreshCycleId: first.cycle.id,
      });
    }

    const isolated = await planCatalogRefresh(repositories, {
      cycleId: '77777777-7777-4777-8777-777777777777',
      league: {
        ...refreshLeague,
        leagueId: '00000000-0000-4000-8000-000000000099',
      },
      now,
      snapshotTtlMs,
    });

    expect(isolated.report).toMatchObject({ cacheHits: 0, cacheMisses: 5 });
  });

  it('applies the configured TTL even when a snapshot expiry is later', async () => {
    const repositories = createInMemoryRepositories();
    await seedCurrentLeague(repositories);
    await repositories.recipes.save(recipe('recipe-a', 'A'));
    const first = await planCatalogRefresh(repositories, {
      cycleId: '44444444-4444-4444-8444-444444444444',
      league: refreshLeague,
      now,
      snapshotTtlMs,
    });
    for (const query of first.queries) {
      await repositories.snapshots.save({
        capturedAt: new Date(now.getTime() - snapshotTtlMs),
        dedupeKey: `stale:${query.canonicalHash}`,
        expiresAt: new Date(now.getTime() + snapshotTtlMs),
        leagueId: first.cycle.leagueId,
        marketQueryId: query.marketQuery.id,
        payload: {},
        providerStatus: 200,
        refreshCycleId: first.cycle.id,
      });
    }

    const stale = await planCatalogRefresh(repositories, {
      cycleId: '55555555-5555-4555-8555-555555555555',
      league: refreshLeague,
      now,
      snapshotTtlMs,
    });

    expect(stale.report).toMatchObject({
      cacheHits: 0,
      cacheMisses: 3,
      jobsEnqueued: 3,
    });
  });
});
