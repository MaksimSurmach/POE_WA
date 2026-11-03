import { describe, expect, it } from 'vitest';

import {
  recipeTrendResponseSchema,
  trendOverviewResponseSchema,
  trendRangeSchema,
} from './index.js';

const correlationId = '11111111-1111-4111-8111-111111111111';
const at = '2026-11-03T00:00:00.000Z';
const bucket = {
  start: at,
  firstObservedAt: at,
  lastObservedAt: at,
  open: 10,
  high: 10,
  low: 10,
  close: 10,
  observations: 1,
  craftCost: null,
  craftCostObservedAt: null,
  minComparableSellers: 1,
  lastComparableSellers: 1,
};
const window = {
  state: 'available',
  range: '1y',
  bucketSeconds: 86400,
  windowStart: at,
  windowEnd: at,
  league: { id: 'league', name: 'League' },
  priceBasis: 'asking',
  salesVolume: 'unknown',
};
const trend = (buckets: unknown[]) => ({
  correlationId,
  data: {
    ...window,
    recipeId: 'recipe',
    title: 'Recipe',
    summary: null,
    buckets,
  },
});

describe('trend contracts', () => {
  it('accepts only the supported ranges', () => {
    expect(trendRangeSchema.options).toEqual(['24h', '7d', '30d', '1y']);
    expect(trendRangeSchema.safeParse('90d').success).toBe(false);
  });

  it('caps returned buckets and rejects empty or zero-filled buckets', () => {
    expect(
      recipeTrendResponseSchema.safeParse(trend(Array(366).fill(bucket)))
        .success,
    ).toBe(true);
    expect(
      recipeTrendResponseSchema.safeParse(trend(Array(367).fill(bucket)))
        .success,
    ).toBe(false);
    expect(
      recipeTrendResponseSchema.safeParse(
        trend([{ ...bucket, observations: 0 }]),
      ).success,
    ).toBe(false);
  });

  it('labels asks and refuses invented sales volume', () => {
    expect(
      trendOverviewResponseSchema.safeParse({
        correlationId,
        data: { ...window, entries: [] },
      }).success,
    ).toBe(true);
    expect(
      trendOverviewResponseSchema.safeParse({
        correlationId,
        data: { ...window, salesVolume: 12, entries: [] },
      }).success,
    ).toBe(false);
    expect(
      recipeTrendResponseSchema.safeParse(trend([{ ...bucket, volume: 3 }]))
        .success,
    ).toBe(false);
  });
});
