import { describe, expect, it } from 'vitest';

import { classifyScrapedItemTest } from './scrapedItemTest.js';

const scheduleId = '11111111-1111-4111-8111-111111111111';
const captureId = '22222222-2222-4222-8222-222222222222';
const base = {
  state: 'done',
  summary: null as Record<string, unknown> | null,
};

describe('classifyScrapedItemTest', () => {
  it('reports queued and running requests without inventing an outcome', () => {
    expect(classifyScrapedItemTest({ ...base, state: 'queued' })).toEqual({
      state: 'queued',
      reason: null,
      captureId: null,
    });
    expect(
      classifyScrapedItemTest({
        ...base,
        state: 'running',
        summary: {
          pending: [scheduleId],
          succeeded: 0,
          failed: 0,
          results: [],
        },
      }),
    ).toEqual({ state: 'running', reason: null, captureId: null });
  });

  it('ties a succeeded test to the capture it produced', () => {
    expect(
      classifyScrapedItemTest({
        ...base,
        summary: {
          pending: [],
          succeeded: 1,
          failed: 0,
          results: [
            { scheduleId, status: 'succeeded', reason: null, captureId },
          ],
        },
      }),
    ).toEqual({ state: 'succeeded', reason: null, captureId });
  });

  it.each([
    ['PROVIDER_CHALLENGE', 'blocked'],
    ['PROVIDER_ACCESS_DENIED', 'blocked'],
    ['PROVIDER_AUTH_FAILED', 'blocked'],
    ['MARKET_ACCESS_BLOCKED', 'blocked'],
    ['TRADE_SESSION_DECRYPT_FAILED', 'blocked'],
    ['PROVIDER_RATE_LIMITED', 'failed'],
    ['SEARCH_TOTAL_MISMATCH', 'failed'],
  ])('classifies a %s collector outcome as %s', (reason, state) => {
    expect(
      classifyScrapedItemTest({
        ...base,
        state: 'failed',
        summary: {
          pending: [],
          succeeded: 0,
          failed: 1,
          results: [
            {
              scheduleId,
              status: state === 'blocked' ? 'blocked' : 'retry',
              reason,
              captureId: null,
            },
          ],
        },
      }),
    ).toEqual({ state, reason, captureId: null });
  });

  it('treats a paused or replaced search as blocked, not as a scraping failure', () => {
    for (const reason of ['COLLECTIONS_PAUSED', 'SCHEDULE_UNAVAILABLE'])
      expect(
        classifyScrapedItemTest({
          ...base,
          state: 'failed',
          summary: {
            pending: [],
            succeeded: 0,
            failed: 1,
            results: [
              { scheduleId, status: 'unavailable', reason, captureId: null },
            ],
          },
        }),
      ).toEqual({ state: 'blocked', reason, captureId: null });
    expect(
      classifyScrapedItemTest({
        ...base,
        state: 'failed',
        summary: {
          pending: [],
          succeeded: 0,
          failed: 0,
          error: 'COLLECTOR_NO_ELIGIBLE_TARGETS',
        },
      }),
    ).toEqual({
      state: 'blocked',
      reason: 'COLLECTOR_NO_ELIGIBLE_TARGETS',
      captureId: null,
    });
  });

  it('never reports success without evidence of a successful search', () => {
    expect(classifyScrapedItemTest({ ...base, summary: null })).toMatchObject({
      state: 'failed',
      reason: 'COLLECTOR_REQUEST_RESULT_MISSING',
    });
  });
});
