import { describe, expect, it } from 'vitest';
import type { RefreshProgressResponse } from '@poe-worksmith/contracts';

import { formatRefreshFreshness } from './refreshFreshness.js';

const now = Date.parse('2026-07-22T12:00:00.000Z');
const base = {
  active: null,
  lastAttempt: null,
  lastSuccessful: null,
  published: null,
  schedule: {
    cron: '0 */4 * * *',
    nextScheduledAt: '2026-07-22T16:00:00.000Z',
    timezone: 'UTC',
  },
  serverTime: '2026-07-22T12:00:00.000Z',
} as const;

describe('refresh freshness', () => {
  it.each([
    ['never-published', 'Awaiting first market publication'],
    ['scheduled', 'Next refresh'],
    ['queued', 'Refresh queued'],
    ['running', 'Refresh in progress'],
    ['failed', 'Last refresh failed'],
    ['published', 'Last snapshot'],
  ] as const)('renders %s semantics', (state, text) => {
    const data: RefreshProgressResponse['data'] = {
      ...base,
      state,
      active:
        state === 'running'
          ? {
              completedQueries: 1,
              completedRecipes: 1,
              failedQueries: 0,
              failedRecipes: 0,
              finishedAt: null,
              id: 'active',
              publishedAt: null,
              requestedAt: base.serverTime,
              startedAt: base.serverTime,
              status: 'running',
              totalQueries: 2,
              totalRecipes: 2,
            }
          : state === 'queued'
            ? {
                completedQueries: 0,
                completedRecipes: 0,
                failedQueries: 0,
                failedRecipes: 0,
                finishedAt: null,
                id: 'active',
                publishedAt: null,
                requestedAt: base.serverTime,
                startedAt: null,
                status: 'queued',
                totalQueries: 2,
                totalRecipes: 2,
              }
            : null,
      lastAttempt:
        state === 'failed'
          ? {
              completedQueries: 0,
              completedRecipes: 0,
              failedQueries: 1,
              failedRecipes: 1,
              finishedAt: base.serverTime,
              id: 'failed',
              publishedAt: null,
              requestedAt: base.serverTime,
              startedAt: base.serverTime,
              status: 'failed',
              totalQueries: 1,
              totalRecipes: 1,
            }
          : null,
      lastSuccessful:
        state === 'published' || state === 'failed'
          ? { cycleId: 'published', publishedAt: '2026-07-22T11:00:00.000Z' }
          : null,
      published:
        state === 'published' || state === 'failed'
          ? {
              completedQueries: 1,
              completedRecipes: 1,
              failedQueries: 0,
              failedRecipes: 0,
              finishedAt: base.serverTime,
              id: 'published',
              publishedAt: '2026-07-22T11:00:00.000Z',
              requestedAt: '2026-07-22T11:00:00.000Z',
              startedAt: base.serverTime,
              status: 'published',
              totalQueries: 1,
              totalRecipes: 1,
            }
          : null,
    };
    expect(formatRefreshFreshness(data, now)).toContain(text);
  });
});
