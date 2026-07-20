import type {
  AggregatedObservation,
  Job,
  MarketQuery,
  RawSnapshot,
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
  let snapshotId = 0;
  let observationId = 0;
  let evaluationId = 0;
  let publishedCycleId: string | null = null;

  return {
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
      async claimNext(workerId, now) {
        const job = [...jobs.values()]
          .filter(
            (candidate) =>
              ['queued', 'retry'].includes(candidate.status) &&
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
        jobs.set(id, {
          ...job,
          lastError: error,
          lockedAt: null,
          lockedBy: null,
          runAfter: retryAt,
          status,
        });
      },
    },
  };
}
