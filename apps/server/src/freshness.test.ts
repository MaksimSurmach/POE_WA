import type { RefreshCycle } from '@poe-worksmith/domain';
import { describe, expect, it } from 'vitest';

import { deriveRefreshFreshness } from './freshness.js';

const now = new Date('2026-03-29T00:30:00.000Z');
const cycle = (
  status: RefreshCycle['status'],
  requestedAt = now,
): RefreshCycle => ({
  completedQueries: 0,
  completedRecipes: 0,
  errorMessage: null,
  failedQueries: 0,
  failedRecipes: 0,
  finishedAt: null,
  id: status,
  leagueId: 'league',
  publishedAt: status === 'published' ? requestedAt : null,
  requestedAt,
  startedAt: null,
  status,
  totalQueries: 1,
  totalRecipes: 1,
});

describe('refresh freshness', () => {
  it.each([
    ['never-published', null, null, null],
    ['queued', cycle('queued'), null, cycle('queued')],
    ['running', cycle('running'), null, cycle('running')],
    ['scheduled', null, null, cycle('completed')],
    ['published', null, cycle('published'), cycle('published')],
  ] as const)('derives %s', (state, active, published, lastAttempt) => {
    expect(
      deriveRefreshFreshness({
        now,
        active,
        published,
        lastAttempt,
        cron: '0 */4 * * *',
        timezone: 'UTC',
      }).state,
    ).toBe(state);
  });

  it('keeps an older publication as last successful after a failure', () => {
    const published = cycle('published', new Date('2026-03-28T20:00:00.000Z'));
    const failed = cycle('failed', now);
    const freshness = deriveRefreshFreshness({
      now,
      active: null,
      published,
      lastAttempt: failed,
      cron: '0 */4 * * *',
      timezone: 'UTC',
    });
    expect(freshness).toMatchObject({
      state: 'failed',
      lastSuccessful: { cycleId: 'published' },
    });
  });

  it('calculates UTC and DST-aware next occurrences', () => {
    expect(
      deriveRefreshFreshness({
        now,
        active: null,
        published: null,
        lastAttempt: null,
        cron: '0 */4 * * *',
        timezone: 'UTC',
      }).schedule.nextScheduledAt.toISOString(),
    ).toBe('2026-03-29T04:00:00.000Z');
    expect(
      deriveRefreshFreshness({
        now,
        active: null,
        published: null,
        lastAttempt: null,
        cron: '0 3 * * *',
        timezone: 'Europe/Warsaw',
      }).schedule.nextScheduledAt.toISOString(),
    ).toBe('2026-03-30T01:00:00.000Z');
  });
});
