import { DomainError } from './errors.js';
import type {
  Job,
  JobStatus,
  NewRawSnapshot,
  RefreshCycle,
  RefreshCycleStatus,
} from './models.js';

export const MIN_PUBLICATION_SUCCESS_PERCENT = 95;

const refreshTransitions: Record<RefreshCycleStatus, RefreshCycleStatus[]> = {
  completed: [],
  failed: [],
  published: ['superseded'],
  queued: ['failed', 'running'],
  running: ['completed', 'failed', 'published'],
  superseded: [],
};

const jobTransitions: Record<JobStatus, JobStatus[]> = {
  failed: [],
  queued: ['running'],
  retry: ['running'],
  running: ['failed', 'retry', 'succeeded'],
  succeeded: [],
};

export function assertNewRefreshCycle(cycle: RefreshCycle) {
  if (cycle.status !== 'queued') {
    throw new DomainError('REFRESH_TRANSITION_INVALID');
  }
  assertRefreshCycleInvariant(cycle);
}

export function assertRefreshTransition(
  from: RefreshCycleStatus,
  to: RefreshCycleStatus,
) {
  if (from === to) return;
  if (!refreshTransitions[from].includes(to)) {
    throw new DomainError('REFRESH_TRANSITION_INVALID');
  }
}

export function assertRefreshCycleInvariant(cycle: RefreshCycle) {
  if (
    !Number.isInteger(cycle.totalQueries) ||
    !Number.isInteger(cycle.totalRecipes) ||
    !Number.isInteger(cycle.completedQueries) ||
    !Number.isInteger(cycle.completedRecipes) ||
    !Number.isInteger(cycle.failedQueries) ||
    !Number.isInteger(cycle.failedRecipes) ||
    cycle.totalQueries < 0 ||
    cycle.totalRecipes < 0 ||
    cycle.completedQueries < 0 ||
    cycle.completedRecipes < 0 ||
    cycle.failedQueries < 0 ||
    cycle.failedRecipes < 0 ||
    cycle.completedQueries + cycle.failedQueries > cycle.totalQueries ||
    cycle.completedRecipes + cycle.failedRecipes > cycle.totalRecipes
  ) {
    throw new DomainError('REFRESH_STATE_INVALID');
  }

  const validTimestamps =
    (cycle.status === 'queued' &&
      cycle.startedAt === null &&
      cycle.finishedAt === null &&
      cycle.publishedAt === null) ||
    (cycle.status === 'running' &&
      cycle.startedAt !== null &&
      cycle.finishedAt === null &&
      cycle.publishedAt === null) ||
    (cycle.status === 'failed' &&
      cycle.finishedAt !== null &&
      cycle.publishedAt === null) ||
    (cycle.status === 'completed' &&
      cycle.finishedAt !== null &&
      cycle.publishedAt === null) ||
    (cycle.status === 'published' &&
      cycle.startedAt !== null &&
      cycle.finishedAt !== null &&
      cycle.publishedAt !== null) ||
    (cycle.status === 'superseded' &&
      cycle.finishedAt !== null &&
      cycle.publishedAt !== null);

  if (!validTimestamps) throw new DomainError('REFRESH_STATE_INVALID');
}

export function assertSingleRunningCycle(
  runningCycleId: string | null,
  candidateCycleId: string,
) {
  if (runningCycleId && runningCycleId !== candidateCycleId) {
    throw new DomainError('REFRESH_ALREADY_RUNNING');
  }
}

export function assertPublicationReady(
  cycle: Pick<
    RefreshCycle,
    'completedRecipes' | 'failedRecipes' | 'status' | 'totalRecipes'
  >,
) {
  if (cycle.status !== 'running') {
    throw new DomainError('PUBLICATION_TRANSITION_INVALID');
  }
  if (
    cycle.totalRecipes === 0 ||
    cycle.completedRecipes + cycle.failedRecipes !== cycle.totalRecipes
  ) {
    throw new DomainError('PUBLICATION_INCOMPLETE');
  }
  if (
    cycle.completedRecipes * 100 <
    cycle.totalRecipes * MIN_PUBLICATION_SUCCESS_PERCENT
  ) {
    throw new DomainError('PUBLICATION_BELOW_THRESHOLD');
  }
}

export function transitionRefreshCycle(
  cycle: RefreshCycle,
  status: RefreshCycleStatus,
  at: Date,
  errorMessage: string | null = null,
): RefreshCycle {
  assertRefreshTransition(cycle.status, status);
  if (cycle.status === status) return cycle;

  const transitioned: RefreshCycle = {
    ...cycle,
    errorMessage:
      status === 'failed' || status === 'completed'
        ? errorMessage
        : cycle.errorMessage,
    finishedAt:
      status === 'completed' || status === 'failed' || status === 'published'
        ? at
        : cycle.finishedAt,
    publishedAt: status === 'published' ? at : cycle.publishedAt,
    startedAt: status === 'running' ? at : cycle.startedAt,
    status,
  };
  assertRefreshCycleInvariant(transitioned);
  return transitioned;
}

export function assertJobTransition(from: JobStatus, to: JobStatus) {
  if (from === to) return;
  if (!jobTransitions[from].includes(to)) {
    throw new DomainError('JOB_TRANSITION_INVALID');
  }
}

export function assertNewJob(job: Job) {
  if (
    job.status !== 'queued' ||
    job.attempts !== 0 ||
    job.lockedAt !== null ||
    job.lockedBy !== null ||
    job.lastError !== null
  ) {
    throw new DomainError('JOB_PAYLOAD_INVALID');
  }
}

export function assertSnapshotInvariant(snapshot: NewRawSnapshot) {
  if (
    !snapshot.dedupeKey ||
    !snapshot.marketQueryId ||
    !snapshot.refreshCycleId ||
    snapshot.providerStatus < 100 ||
    snapshot.providerStatus > 599 ||
    snapshot.expiresAt <= snapshot.capturedAt
  ) {
    throw new DomainError('SNAPSHOT_INVALID');
  }
}
