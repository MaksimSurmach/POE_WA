import { randomUUID } from 'node:crypto';

import {
  canonicalizeMarketQuery,
  DomainError,
  hashMarketQuery,
  type CanonicalJsonObject,
  type Job,
  type MarketQuery,
  type RawSnapshot,
  type Recipe,
  type RefreshCycle,
  type Repositories,
  validateRecipeDocument,
} from '@poe-worksmith/domain';

import type { RefreshLeagueContext } from './refreshLeagueContext.js';
import {
  legacyRecipeMarketDependencies,
  type RecipeMarketDependencies,
} from './recipeMarket.js';
import type { Logger } from 'pino';
import type { Metrics } from './observability/metrics.js';

type RefreshDependency = {
  canonicalHash: string;
  provider: string;
  query: CanonicalJsonObject;
  recipeIds: string[];
  schemaVersion: number;
};

type ResolvedRefreshDependency = RefreshDependency & {
  cache: 'hit' | 'miss';
  marketQuery: MarketQuery;
  snapshot: RawSnapshot | null;
};

export type PlannedMarketQuery = Readonly<{
  cache: 'hit' | 'miss';
  canonicalHash: string;
  job: Job | null;
  jobDisposition: 'enqueued' | 'reused' | null;
  marketQuery: MarketQuery;
  recipeIds: readonly string[];
  snapshot: RawSnapshot | null;
}>;

export type RefreshPlanReport = Readonly<{
  cacheHits: number;
  cacheMisses: number;
  deduplicatedDependencies: number;
  jobsEnqueued: number;
  jobsReused: number;
  totalDependencies: number;
  totalQueries: number;
  totalRecipes: number;
}>;

export type CatalogRefreshPlan = Readonly<{
  cycle: RefreshCycle;
  queries: readonly PlannedMarketQuery[];
  report: RefreshPlanReport;
}>;

export async function planCatalogRefresh(
  repositories: Repositories,
  options: {
    createId?: () => string;
    cycleId?: string;
    league: RefreshLeagueContext;
    maxAttempts?: number;
    marketDependencies?: RecipeMarketDependencies;
    now?: Date;
    priority?: number;
    snapshotTtlMs: number;
    logger?: Logger;
    metrics?: Metrics;
  },
): Promise<CatalogRefreshPlan> {
  const now = options.now ?? new Date();
  const createId = options.createId ?? randomUUID;
  const cycleId = options.cycleId ?? createId();
  const league = options.league;
  const maxAttempts = options.maxAttempts ?? 3;
  const priority = options.priority ?? 10;
  assertPlannerOptions({
    cycleId,
    league,
    maxAttempts,
    now,
    priority,
    snapshotTtlMs: options.snapshotTtlMs,
  });

  const recipes = (await repositories.recipes.listActive()).sort(
    (left, right) => left.id.localeCompare(right.id),
  );
  const { dependencies, totalDependencies } = await buildDependencies(
    recipes,
    league.leagueGggId,
    options.marketDependencies,
  );
  const existingCycle = await repositories.cycles.findById(cycleId);
  if (
    existingCycle &&
    (existingCycle.totalRecipes !== recipes.length ||
      existingCycle.totalQueries !== dependencies.length)
  ) {
    throw new DomainError('REFRESH_STATE_INVALID');
  }
  if (existingCycle && existingCycle.leagueId !== league.leagueId) {
    throw new DomainError('REFRESH_STATE_INVALID');
  }
  const resolved: ResolvedRefreshDependency[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  for (const dependency of dependencies) {
    const marketQuery = await findOrCreateMarketQuery(
      repositories,
      dependency,
      createId,
    );
    const snapshot = await repositories.snapshots.findLatest(
      marketQuery.id,
      league.leagueId,
    );
    const cache = isFreshSnapshot(snapshot, now, options.snapshotTtlMs)
      ? 'hit'
      : 'miss';
    if (cache === 'hit') cacheHits += 1;
    else cacheMisses += 1;
    resolved.push({ ...dependency, cache, marketQuery, snapshot });
  }

  const cycle =
    existingCycle ??
    (await repositories.cycles.save({
      completedQueries: cacheHits,
      completedRecipes: 0,
      errorMessage: null,
      failedQueries: 0,
      failedRecipes: 0,
      finishedAt: null,
      id: cycleId,
      leagueId: league.leagueId,
      publishedAt: null,
      requestedAt: now,
      startedAt: null,
      status: 'queued',
      totalQueries: dependencies.length,
      totalRecipes: recipes.length,
    }));

  const queries: PlannedMarketQuery[] = [];
  let jobsEnqueued = 0;
  let jobsReused = 0;
  for (const dependency of resolved) {
    if (dependency.cache === 'hit') {
      queries.push({
        cache: 'hit',
        canonicalHash: dependency.canonicalHash,
        job: null,
        jobDisposition: null,
        marketQuery: dependency.marketQuery,
        recipeIds: dependency.recipeIds,
        snapshot: dependency.snapshot,
      });
      continue;
    }

    const candidate: Job = {
      attempts: 0,
      dedupeKey: `market-refresh:${cycle.id}:${dependency.canonicalHash}`,
      id: createId(),
      kind: 'recipe_refresh',
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      marketQueryId: dependency.marketQuery.id,
      maxAttempts,
      payload: {
        canonicalHash: dependency.canonicalHash,
        leagueGggId: league.leagueGggId,
        leagueId: league.leagueId,
        leagueName: league.leagueName,
        provider: dependency.provider,
        recipeIds: dependency.recipeIds,
        schemaVersion: dependency.schemaVersion,
      },
      priority,
      recipeId: dependency.recipeIds[0]!,
      refreshCycleId: cycle.id,
      runAfter: now,
      status: 'queued',
    };
    const job = await repositories.jobs.enqueue(candidate);
    const jobDisposition = job.id === candidate.id ? 'enqueued' : 'reused';
    if (jobDisposition === 'enqueued') jobsEnqueued += 1;
    else jobsReused += 1;
    queries.push({
      cache: 'miss',
      canonicalHash: dependency.canonicalHash,
      job,
      jobDisposition,
      marketQuery: dependency.marketQuery,
      recipeIds: dependency.recipeIds,
      snapshot: dependency.snapshot,
    });
  }

  options.logger?.info(
    {
      cacheHits,
      cacheMisses,
      cycleId,
      leagueId: league.leagueId,
      leagueGggId: league.leagueGggId,
    },
    'refresh.planned',
  );
  options.metrics?.snapshotCache.inc({ result: 'hit' }, cacheHits);
  options.metrics?.snapshotCache.inc({ result: 'miss' }, cacheMisses);
  return {
    cycle,
    queries,
    report: {
      cacheHits,
      cacheMisses,
      deduplicatedDependencies: totalDependencies - dependencies.length,
      jobsEnqueued,
      jobsReused,
      totalDependencies,
      totalQueries: dependencies.length,
      totalRecipes: recipes.length,
    },
  };
}

async function buildDependencies(
  recipes: readonly Recipe[],
  league: string,
  marketDependencies?: RecipeMarketDependencies,
) {
  const dependencies = new Map<string, RefreshDependency>();
  let totalDependencies = 0;

  for (const recipe of recipes) {
    let definition;
    try {
      definition = validateRecipeDocument(recipe.definition);
    } catch (cause) {
      throw new DomainError('RECIPE_INVALID', { cause });
    }

    const queries = marketDependencies
      ? await marketDependencies({ league, recipe: definition })
      : definition.schemaVersion === 1
        ? legacyRecipeMarketDependencies({ recipe: definition })
        : (() => {
            throw new DomainError('RECIPE_INVALID');
          })();
    for (const { query: tradeQuery } of queries) {
      totalDependencies += 1;
      const query = canonicalizeMarketQuery(tradeQuery.query);
      const canonicalHash = await hashMarketQuery({
        league,
        provider: tradeQuery.provider,
        query,
        schemaVersion: tradeQuery.schemaVersion,
      });
      const existing = dependencies.get(canonicalHash);
      if (existing) {
        if (!existing.recipeIds.includes(recipe.id)) {
          existing.recipeIds.push(recipe.id);
        }
      } else {
        dependencies.set(canonicalHash, {
          canonicalHash,
          provider: tradeQuery.provider,
          query,
          recipeIds: [recipe.id],
          schemaVersion: tradeQuery.schemaVersion,
        });
      }
    }
  }

  return {
    dependencies: [...dependencies.values()].map((dependency) => ({
      ...dependency,
      recipeIds: dependency.recipeIds.sort(),
    })),
    totalDependencies,
  };
}

async function findOrCreateMarketQuery(
  repositories: Repositories,
  dependency: RefreshDependency,
  createId: () => string,
) {
  const existing = await repositories.marketQueries.findByCanonicalHash(
    dependency.canonicalHash,
  );
  if (existing) return existing;

  return repositories.marketQueries.save({
    active: true,
    canonicalHash: dependency.canonicalHash,
    id: createId(),
    provider: dependency.provider,
    query: dependency.query,
    recipeId: dependency.recipeIds[0]!,
  });
}

function isFreshSnapshot(
  snapshot: RawSnapshot | null,
  now: Date,
  snapshotTtlMs: number,
) {
  if (!snapshot) return false;
  const age = now.getTime() - snapshot.capturedAt.getTime();
  return age >= 0 && age < snapshotTtlMs && snapshot.expiresAt > now;
}

function assertPlannerOptions(options: {
  cycleId: string;
  league: RefreshLeagueContext;
  maxAttempts: number;
  now: Date;
  priority: number;
  snapshotTtlMs: number;
}) {
  if (
    options.cycleId.trim().length === 0 ||
    Object.values(options.league).some((value) => value.trim().length === 0) ||
    !Number.isFinite(options.now.getTime()) ||
    !Number.isInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    !Number.isInteger(options.priority) ||
    !Number.isInteger(options.snapshotTtlMs) ||
    options.snapshotTtlMs < 1
  ) {
    throw new DomainError('REFRESH_STATE_INVALID');
  }
}
