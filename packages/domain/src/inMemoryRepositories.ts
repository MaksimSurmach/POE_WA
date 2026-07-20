import type {
  AggregatedObservation,
  Job,
  MarketQuery,
  RawSnapshot,
  RateLimitState,
  Recipe,
  RecipeEvaluation,
  RefreshCycle,
} from './models.js';
import {
  assertJobTransition,
  assertNewJob,
  assertNewRefreshCycle,
  assertPublicationReady,
  assertRefreshCycleInvariant,
  assertRefreshTransition,
  assertSnapshotInvariant,
  assertSingleRunningCycle,
  transitionRefreshCycle,
} from './invariants.js';
import type { Repositories } from './repositories.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createInMemoryRepositories(): Repositories {
  const recipes = new Map<string, Recipe>();
  const marketQueries = new Map<string, MarketQuery>();
  const snapshots = new Map<number, RawSnapshot>();
  const observations = new Map<number, AggregatedObservation>();
  const evaluations = new Map<number, RecipeEvaluation>();
  const cycles = new Map<string, RefreshCycle>();
  const jobs = new Map<string, Job>();
  const endpointPolicies = new Map<string, string>();
  const rateLimitStates = new Map<string, RateLimitState>();
  let snapshotId = 0;
  let observationId = 0;
  let evaluationId = 0;
  let publishedCycleId: string | null = null;

  function incrementQueryProgress(
    cycleId: string | null,
    field: 'completedQueries' | 'failedQueries',
  ) {
    if (!cycleId) return;
    const cycle = cycles.get(cycleId);
    if (!cycle) throw new Error(`Refresh cycle ${cycleId} does not exist`);
    const updated = { ...cycle, [field]: cycle[field] + 1 };
    assertRefreshCycleInvariant(updated);
    cycles.set(cycleId, updated);
  }

  function initialRateLimitState(
    policy: string,
    now: Date,
    minimumDelayMs: number,
  ): RateLimitState {
    return {
      blockedUntil: now,
      endpoints: [],
      lastResponseAt: null,
      lastStatus: null,
      minimumDelayMs,
      nextRequestAt: now,
      policy,
      updatedAt: now,
      windows: [],
    };
  }

  return {
    catalog: {
      async getProgress() {
        const active = [...cycles.values()]
          .filter(({ status }) => ['queued', 'running'].includes(status))
          .sort(
            (left, right) =>
              Number(right.status === 'running') -
                Number(left.status === 'running') ||
              right.requestedAt.getTime() - left.requestedAt.getTime(),
          )[0];
        const published = publishedCycleId
          ? cycles.get(publishedCycleId)
          : null;
        return {
          active: active ? clone(active) : null,
          published: published ? clone(published) : null,
        };
      },
      async getPublished() {
        if (!publishedCycleId) return null;
        const cycle = cycles.get(publishedCycleId);
        if (!cycle) throw new Error('Published refresh cycle does not exist');
        const publishedEvaluations = [...evaluations.values()]
          .filter(
            (evaluation) => evaluation.refreshCycleId === publishedCycleId,
          )
          .sort((left, right) => left.recipeId.localeCompare(right.recipeId));
        const publishedRecipes = publishedEvaluations.map((evaluation) => {
          const recipe = recipes.get(evaluation.recipeId);
          if (!recipe) {
            throw new Error(`Recipe ${evaluation.recipeId} does not exist`);
          }
          return clone(recipe);
        });
        return {
          cycle: clone(cycle),
          evaluations: publishedEvaluations.map(clone),
          recipes: publishedRecipes,
        };
      },
    },
    recipes: {
      async findById(id) {
        const recipe = recipes.get(id);
        return recipe ? clone(recipe) : null;
      },
      async listAll() {
        return [...recipes.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(clone);
      },
      async listActive() {
        return [...recipes.values()]
          .filter(({ active }) => active)
          .sort((left, right) => left.title.localeCompare(right.title))
          .map(clone);
      },
      async save(recipe) {
        const conflicting = [...recipes.values()].find(
          ({ contentHash, id }) =>
            contentHash === recipe.contentHash && id !== recipe.id,
        );
        if (conflicting) {
          throw new Error(
            `Recipe content hash already belongs to ${conflicting.id}`,
          );
        }
        recipes.set(recipe.id, clone(recipe));
        return clone(recipe);
      },
    },
    marketQueries: {
      async findByCanonicalHash(canonicalHash) {
        const query = [...marketQueries.values()].find(
          (candidate) => candidate.canonicalHash === canonicalHash,
        );
        return query ? clone(query) : null;
      },
      async save(query) {
        const existing = [...marketQueries.values()].find(
          (candidate) => candidate.canonicalHash === query.canonicalHash,
        );
        const saved = existing ? { ...query, id: existing.id } : query;
        marketQueries.set(saved.id, clone(saved));
        return clone(saved);
      },
    },
    marketResults: {
      async commitSuccess(result) {
        assertSnapshotInvariant(result.snapshot);
        const job = jobs.get(result.jobId);
        if (!job) throw new Error(`Job ${result.jobId} does not exist`);
        if (job.status === 'succeeded') return { applied: false };
        assertJobTransition(job.status, 'succeeded');
        if (
          job.refreshCycleId !== result.snapshot.refreshCycleId ||
          job.refreshCycleId !== result.observation.refreshCycleId ||
          job.marketQueryId !== result.snapshot.marketQueryId ||
          job.marketQueryId !== result.observation.marketQueryId
        ) {
          throw new Error('Market result does not match its job');
        }

        const existingSnapshot = [...snapshots.values()].find(
          (candidate) => candidate.dedupeKey === result.snapshot.dedupeKey,
        );
        const snapshot = existingSnapshot ?? {
          ...clone(result.snapshot),
          id: ++snapshotId,
        };
        const existingObservation = [...observations.values()].find(
          (candidate) =>
            candidate.marketQueryId === result.observation.marketQueryId &&
            candidate.refreshCycleId === result.observation.refreshCycleId,
        );
        const observation = existingObservation ?? {
          ...clone(result.observation),
          id: ++observationId,
        };
        incrementQueryProgress(job.refreshCycleId, 'completedQueries');
        snapshots.set(snapshot.id, snapshot);
        observations.set(observation.id, observation);
        jobs.set(job.id, {
          ...job,
          lastError: null,
          lockedAt: null,
          lockedBy: null,
          status: 'succeeded',
        });
        return { applied: true };
      },
    },
    snapshots: {
      async deleteExpired(before) {
        let deleted = 0;
        for (const [id, snapshot] of snapshots) {
          if (snapshot.expiresAt <= before) {
            snapshots.delete(id);
            deleted += 1;
          }
        }
        return deleted;
      },
      async findLatest(marketQueryId) {
        const latest = [...snapshots.values()]
          .filter((snapshot) => snapshot.marketQueryId === marketQueryId)
          .sort(
            (left, right) =>
              right.capturedAt.getTime() - left.capturedAt.getTime(),
          )[0];
        return latest ? clone(latest) : null;
      },
      async save(snapshot) {
        assertSnapshotInvariant(snapshot);
        const existing = [...snapshots.values()].find(
          (candidate) => candidate.dedupeKey === snapshot.dedupeKey,
        );
        if (existing) {
          return { inserted: false, snapshot: clone(existing) };
        }
        const saved = { ...clone(snapshot), id: ++snapshotId };
        snapshots.set(saved.id, saved);
        return { inserted: true, snapshot: clone(saved) };
      },
    },
    observations: {
      async listRecent(marketQueryId, since) {
        return [...observations.values()]
          .filter(
            (observation) =>
              observation.marketQueryId === marketQueryId &&
              observation.observedAt >= since,
          )
          .sort(
            (left, right) =>
              right.observedAt.getTime() - left.observedAt.getTime(),
          )
          .map(clone);
      },
      async save(observation) {
        const existing = [...observations.values()].find(
          (candidate) =>
            candidate.marketQueryId === observation.marketQueryId &&
            candidate.refreshCycleId === observation.refreshCycleId,
        );
        const saved = {
          ...clone(observation),
          id: existing?.id ?? ++observationId,
        };
        observations.set(saved.id, saved);
        return clone(saved);
      },
    },
    rateLimits: {
      async acquire(input) {
        const policy =
          endpointPolicies.get(input.endpoint) ?? input.fallbackPolicy;
        const current =
          rateLimitStates.get(policy) ??
          initialRateLimitState(policy, input.now, input.conservativeDelayMs);
        const retryAt = new Date(
          Math.max(
            current.blockedUntil.getTime(),
            current.nextRequestAt.getTime(),
            input.now.getTime(),
          ),
        );
        const acquired = retryAt <= input.now;
        const state: RateLimitState = {
          ...current,
          endpoints: [...new Set([...current.endpoints, input.endpoint])],
          nextRequestAt: acquired
            ? new Date(input.now.getTime() + current.minimumDelayMs)
            : current.nextRequestAt,
          updatedAt: input.now,
        };
        rateLimitStates.set(policy, clone(state));
        return { acquired, retryAt, state: clone(state) };
      },
      async list() {
        return [...rateLimitStates.values()]
          .filter(({ endpoints }) => endpoints.length > 0)
          .sort((left, right) => left.policy.localeCompare(right.policy))
          .map(clone);
      },
      async observe(input) {
        const previousPolicy =
          endpointPolicies.get(input.endpoint) ?? input.fallbackPolicy;
        const previous =
          rateLimitStates.get(previousPolicy) ??
          initialRateLimitState(
            previousPolicy,
            input.now,
            input.minimumDelayMs,
          );
        const current =
          rateLimitStates.get(input.policy) ??
          initialRateLimitState(input.policy, input.now, input.minimumDelayMs);
        if (previousPolicy !== input.policy) {
          rateLimitStates.set(previousPolicy, {
            ...previous,
            endpoints: previous.endpoints.filter(
              (endpoint) => endpoint !== input.endpoint,
            ),
          });
        }
        endpointPolicies.set(input.endpoint, input.policy);
        const state: RateLimitState = {
          blockedUntil: new Date(
            Math.max(
              current.blockedUntil.getTime(),
              previous.blockedUntil.getTime(),
              input.blockedUntil.getTime(),
            ),
          ),
          endpoints: [...new Set([...current.endpoints, input.endpoint])],
          lastResponseAt: input.now,
          lastStatus: input.status,
          minimumDelayMs: input.minimumDelayMs,
          nextRequestAt: new Date(
            Math.max(
              current.nextRequestAt.getTime(),
              previous.nextRequestAt.getTime(),
              input.now.getTime() + input.minimumDelayMs,
            ),
          ),
          policy: input.policy,
          updatedAt: input.now,
          windows: clone(input.windows),
        };
        rateLimitStates.set(input.policy, clone(state));
        return clone(state);
      },
    },
    evaluations: {
      async findByRecipeAndCycle(recipeId, refreshCycleId) {
        const evaluation = [...evaluations.values()].find(
          (candidate) =>
            candidate.recipeId === recipeId &&
            candidate.refreshCycleId === refreshCycleId,
        );
        return evaluation ? clone(evaluation) : null;
      },
      async listByCycle(refreshCycleId) {
        return [...evaluations.values()]
          .filter((evaluation) => evaluation.refreshCycleId === refreshCycleId)
          .map(clone);
      },
      async save(evaluation) {
        const existing = [...evaluations.values()].find(
          (candidate) =>
            candidate.recipeId === evaluation.recipeId &&
            candidate.refreshCycleId === evaluation.refreshCycleId,
        );
        const saved = {
          ...clone(evaluation),
          id: existing?.id ?? ++evaluationId,
        };
        evaluations.set(saved.id, saved);
        return clone(saved);
      },
    },
    cycles: {
      async findById(id) {
        const cycle = cycles.get(id);
        return cycle ? clone(cycle) : null;
      },
      async getPublishedCycleId() {
        return publishedCycleId;
      },
      async publish(id, publishedAt) {
        const cycle = cycles.get(id);
        if (!cycle) throw new Error(`Refresh cycle ${id} does not exist`);
        if (publishedCycleId === id && cycle.status === 'published') return;
        assertPublicationReady(cycle);
        const previous = publishedCycleId ? cycles.get(publishedCycleId) : null;
        if (previous && previous.id !== id) {
          cycles.set(
            previous.id,
            transitionRefreshCycle(previous, 'superseded', publishedAt),
          );
        }
        cycles.set(id, transitionRefreshCycle(cycle, 'published', publishedAt));
        publishedCycleId = id;
      },
      async save(cycle) {
        const current = cycles.get(cycle.id);
        if (cycle.status === 'running') {
          const running = [...cycles.values()].find(
            ({ status }) => status === 'running',
          );
          assertSingleRunningCycle(running?.id ?? null, cycle.id);
        }
        if (current) {
          assertRefreshTransition(current.status, cycle.status);
          assertRefreshCycleInvariant(cycle);
        } else {
          assertNewRefreshCycle(cycle);
        }
        cycles.set(cycle.id, clone(cycle));
        return clone(cycle);
      },
    },
    jobs: {
      async claimNext(workerId, now, kinds) {
        const job = [...jobs.values()]
          .filter(
            (candidate) =>
              ['queued', 'retry'].includes(candidate.status) &&
              (!kinds || kinds.includes(candidate.kind)) &&
              candidate.runAfter <= now &&
              candidate.attempts < candidate.maxAttempts,
          )
          .sort(
            (left, right) =>
              right.priority - left.priority ||
              left.runAfter.getTime() - right.runAfter.getTime(),
          )[0];
        if (!job) return null;
        assertJobTransition(job.status, 'running');
        const claimed: Job = {
          ...job,
          attempts: job.attempts + 1,
          lockedAt: now,
          lockedBy: workerId,
          status: 'running',
        };
        jobs.set(claimed.id, claimed);
        return clone(claimed);
      },
      async complete(id) {
        const job = jobs.get(id);
        if (!job) return;
        assertJobTransition(job.status, 'succeeded');
        jobs.set(id, {
          ...job,
          lastError: null,
          lockedAt: null,
          lockedBy: null,
          status: 'succeeded',
        });
      },
      async enqueue(job) {
        assertNewJob(job);
        const existing = [...jobs.values()].find(
          (candidate) => candidate.dedupeKey === job.dedupeKey,
        );
        if (existing) return clone(existing);
        jobs.set(job.id, clone(job));
        return clone(job);
      },
      async fail(id, error, retryAt) {
        const job = jobs.get(id);
        if (!job) return;
        const status = job.attempts < job.maxAttempts ? 'retry' : 'failed';
        assertJobTransition(job.status, status);
        if (status === 'failed' && job.kind === 'recipe_refresh') {
          incrementQueryProgress(job.refreshCycleId, 'failedQueries');
        }
        jobs.set(id, {
          ...job,
          lastError: error,
          lockedAt: null,
          lockedBy: null,
          runAfter: retryAt,
          status,
        });
      },
      async failPermanently(id, error) {
        const job = jobs.get(id);
        if (!job) return;
        assertJobTransition(job.status, 'failed');
        if (job.kind === 'recipe_refresh') {
          incrementQueryProgress(job.refreshCycleId, 'failedQueries');
        }
        jobs.set(id, {
          ...job,
          lastError: error,
          lockedAt: null,
          lockedBy: null,
          status: 'failed',
        });
      },
      async recoverStale(before, retryAt) {
        let recovered = 0;
        for (const [id, job] of jobs) {
          if (
            job.status !== 'running' ||
            !job.lockedAt ||
            job.lockedAt > before
          ) {
            continue;
          }
          const status = job.attempts < job.maxAttempts ? 'retry' : 'failed';
          assertJobTransition(job.status, status);
          if (status === 'failed' && job.kind === 'recipe_refresh') {
            incrementQueryProgress(job.refreshCycleId, 'failedQueries');
          }
          jobs.set(id, {
            ...job,
            lastError: 'worker_lease_expired',
            lockedAt: null,
            lockedBy: null,
            runAfter: retryAt,
            status,
          });
          recovered += 1;
        }
        return recovered;
      },
    },
    retention: {
      async cleanup(options) {
        if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
          throw new TypeError('batchSize must be a positive integer');
        }
        const protectedCycleIds = new Set(
          [...cycles.values()]
            .filter(({ status }) => ['queued', 'running'].includes(status))
            .map(({ id }) => id),
        );
        if (publishedCycleId) protectedCycleIds.add(publishedCycleId);

        const deleteBatch = <K, T>(
          storage: Map<K, T>,
          predicate: (value: T) => boolean,
        ) => {
          let deleted = 0;
          for (const [id, value] of storage) {
            if (deleted >= options.batchSize) break;
            if (!predicate(value)) continue;
            storage.delete(id);
            deleted += 1;
          }
          return deleted;
        };

        const rawSnapshots = deleteBatch(
          snapshots,
          (snapshot) =>
            snapshot.capturedAt < options.rawSnapshotsBefore &&
            !protectedCycleIds.has(snapshot.refreshCycleId),
        );
        const observationsDeleted = deleteBatch(
          observations,
          (observation) =>
            observation.observedAt < options.observationsBefore &&
            !protectedCycleIds.has(observation.refreshCycleId),
        );
        const jobsDeleted = deleteBatch(
          jobs,
          (job) =>
            ['succeeded', 'failed'].includes(job.status) &&
            job.runAfter < options.jobsBefore &&
            (!job.refreshCycleId || !protectedCycleIds.has(job.refreshCycleId)),
        );

        return {
          jobs: jobsDeleted,
          observations: observationsDeleted,
          rawSnapshots,
        };
      },
    },
  };
}
