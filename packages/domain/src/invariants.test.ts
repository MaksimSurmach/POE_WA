import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import {
  assertJobTransition,
  assertPublicationReady,
  assertRefreshCycleInvariant,
  assertRefreshTransition,
  assertSingleRunningCycle,
  assertSnapshotInvariant,
  transitionRefreshCycle,
} from './invariants.js';
import type { JobStatus, RefreshCycle, RefreshCycleStatus } from './models.js';

const now = new Date('2026-07-20T00:00:00.000Z');
const queuedCycle: RefreshCycle = {
  completedQueries: 0,
  completedRecipes: 0,
  errorMessage: null,
  failedQueries: 0,
  failedRecipes: 0,
  finishedAt: null,
  id: '11111111-1111-4111-8111-111111111111',
  leagueId: '00000000-0000-4000-8000-000000000001',
  publishedAt: null,
  requestedAt: now,
  startedAt: null,
  status: 'queued',
  totalQueries: 200,
  totalRecipes: 100,
};

function errorCode(action: () => void) {
  try {
    action();
    throw new Error('Expected invariant to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return (error as DomainError).code;
  }
}

describe('refresh and publication invariants', () => {
  it('accepts only explicit refresh transitions', () => {
    const statuses: RefreshCycleStatus[] = [
      'queued',
      'running',
      'published',
      'failed',
      'superseded',
    ];
    const allowed = new Set([
      'queued:queued',
      'queued:running',
      'queued:failed',
      'running:running',
      'running:published',
      'running:failed',
      'published:published',
      'published:superseded',
      'failed:failed',
      'superseded:superseded',
    ]);

    for (const from of statuses) {
      for (const to of statuses) {
        const transition = `${from}:${to}`;
        if (allowed.has(transition)) {
          expect(() => assertRefreshTransition(from, to)).not.toThrow();
        } else {
          expect(errorCode(() => assertRefreshTransition(from, to))).toBe(
            'REFRESH_TRANSITION_INVALID',
          );
        }
      }
    }
  });

  it.each([
    { completedRecipes: 95, failedRecipes: 5, totalRecipes: 100 },
    { completedRecipes: 19, failedRecipes: 1, totalRecipes: 20 },
    { completedRecipes: 1, failedRecipes: 0, totalRecipes: 1 },
  ])('allows publication at or above 95%: %o', (counts) => {
    expect(() =>
      assertPublicationReady({ ...counts, status: 'running' }),
    ).not.toThrow();
  });

  it.each([
    {
      code: 'PUBLICATION_BELOW_THRESHOLD',
      cycle: {
        completedRecipes: 94,
        failedRecipes: 6,
        status: 'running' as const,
        totalRecipes: 100,
      },
    },
    {
      code: 'PUBLICATION_INCOMPLETE',
      cycle: {
        completedRecipes: 94,
        failedRecipes: 5,
        status: 'running' as const,
        totalRecipes: 100,
      },
    },
    {
      code: 'PUBLICATION_INCOMPLETE',
      cycle: {
        completedRecipes: 0,
        failedRecipes: 0,
        status: 'running' as const,
        totalRecipes: 0,
      },
    },
    {
      code: 'PUBLICATION_TRANSITION_INVALID',
      cycle: {
        completedRecipes: 100,
        failedRecipes: 0,
        status: 'failed' as const,
        totalRecipes: 100,
      },
    },
  ])('rejects unsafe publication: $code', ({ code, cycle }) => {
    expect(errorCode(() => assertPublicationReady(cycle))).toBe(code);
  });

  it('builds valid timestamped cycle transitions', () => {
    const running = transitionRefreshCycle(queuedCycle, 'running', now);
    const published = transitionRefreshCycle(
      { ...running, completedRecipes: 95, failedRecipes: 5 },
      'published',
      new Date(now.getTime() + 1000),
    );

    expect(running).toMatchObject({ startedAt: now, status: 'running' });
    expect(published).toMatchObject({
      finishedAt: new Date(now.getTime() + 1000),
      publishedAt: new Date(now.getTime() + 1000),
      status: 'published',
    });
    expect(() => assertRefreshCycleInvariant(published)).not.toThrow();
  });

  it('allows only one running cycle', () => {
    expect(() => assertSingleRunningCycle(null, queuedCycle.id)).not.toThrow();
    expect(() =>
      assertSingleRunningCycle(queuedCycle.id, queuedCycle.id),
    ).not.toThrow();
    expect(
      errorCode(() => assertSingleRunningCycle('other-cycle', queuedCycle.id)),
    ).toBe('REFRESH_ALREADY_RUNNING');
  });
});

describe('job and snapshot invariants', () => {
  it('accepts only explicit job transitions', () => {
    const statuses: JobStatus[] = [
      'queued',
      'running',
      'retry',
      'succeeded',
      'failed',
    ];
    const allowed = new Set([
      'queued:queued',
      'queued:running',
      'running:running',
      'running:retry',
      'running:succeeded',
      'running:failed',
      'retry:retry',
      'retry:running',
      'succeeded:succeeded',
      'failed:failed',
    ]);

    for (const from of statuses) {
      for (const to of statuses) {
        if (allowed.has(`${from}:${to}`)) {
          expect(() => assertJobTransition(from, to)).not.toThrow();
        } else {
          expect(errorCode(() => assertJobTransition(from, to))).toBe(
            'JOB_TRANSITION_INVALID',
          );
        }
      }
    }
  });

  it('requires snapshots to have valid identity, status, and lifetime', () => {
    const snapshot = {
      capturedAt: now,
      dedupeKey: 'snapshot-key',
      expiresAt: new Date(now.getTime() + 1000),
      leagueId: queuedCycle.leagueId,
      marketQueryId: 'query-id',
      payload: {},
      providerStatus: 200,
      refreshCycleId: queuedCycle.id,
    };

    expect(() => assertSnapshotInvariant(snapshot)).not.toThrow();
    expect(
      errorCode(() => assertSnapshotInvariant({ ...snapshot, expiresAt: now })),
    ).toBe('SNAPSHOT_INVALID');
    expect(
      errorCode(() =>
        assertSnapshotInvariant({ ...snapshot, providerStatus: 700 }),
      ),
    ).toBe('SNAPSHOT_INVALID');
  });
});
