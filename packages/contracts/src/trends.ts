import { z } from 'zod';

/** Supported history windows; anything else is rejected. */
export const trendRangeSchema = z.enum(['24h', '7d', '30d', '1y']);

const trendCurrencySchema = z.enum(['chaos', 'divine']);
const amountSchema = z.number().finite().nonnegative();

/**
 * One fixed UTC bucket of cheapest-ask observations. Only buckets that hold
 * at least one observation are returned; missing buckets are gaps, not zeros.
 */
export const trendBucketSchema = z.strictObject({
  start: z.iso.datetime(),
  firstObservedAt: z.iso.datetime(),
  lastObservedAt: z.iso.datetime(),
  open: amountSchema,
  high: amountSchema,
  low: amountSchema,
  close: amountSchema,
  /** Independent output source snapshots in this bucket. */
  observations: z.number().int().positive(),
  /** Last expected craft cost recorded with a contemporaneous ask. */
  craftCost: amountSchema.nullable(),
  craftCostObservedAt: z.iso.datetime().nullable(),
  minComparableSellers: z.number().int().nonnegative().nullable(),
  lastComparableSellers: z.number().int().nonnegative().nullable(),
});

/** Change across the observed window; present only with two independent points. */
export const trendChangeSchema = z.strictObject({
  from: amountSchema,
  fromObservedAt: z.iso.datetime(),
  to: amountSchema,
  toObservedAt: z.iso.datetime(),
  absolute: z.number().finite(),
  percent: z.number().finite().nullable(),
});

export const trendSummarySchema = z.strictObject({
  currency: trendCurrencySchema,
  latestAsk: amountSchema,
  latestObservedAt: z.iso.datetime(),
  latestComparableSellers: z.number().int().nonnegative().nullable(),
  latestCoverage: z.enum(['complete', 'partial', 'unknown']).nullable(),
  latestCraftCost: amountSchema.nullable(),
  latestCraftCostObservedAt: z.iso.datetime().nullable(),
  /** Independent observations inside the selected window, in `currency`. */
  windowObservations: z.number().int().nonnegative(),
  windowFirstObservedAt: z.iso.datetime().nullable(),
  windowLastObservedAt: z.iso.datetime().nullable(),
  change: trendChangeSchema.nullable(),
  /** Other currencies observed in the window; never mixed into this series. */
  excludedCurrencies: z.array(trendCurrencySchema),
});

const trendLeagueSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
});

const trendBasisFields = {
  /** Listing asks, not confirmed sales; traded volume is not known. */
  priceBasis: z.literal('asking'),
  salesVolume: z.literal('unknown'),
};

const trendWindowFields = {
  state: z.enum(['available', 'empty', 'unavailable']),
  range: trendRangeSchema,
  bucketSeconds: z.number().int().positive(),
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  league: trendLeagueSchema.nullable(),
  ...trendBasisFields,
};

export const recipeTrendSchema = z.strictObject({
  ...trendWindowFields,
  recipeId: z.string().min(1),
  title: z.string().min(1),
  summary: trendSummarySchema.nullable(),
  buckets: z.array(trendBucketSchema).max(366),
});

export const trendOverviewEntrySchema = z.strictObject({
  recipeId: z.string().min(1),
  title: z.string().min(1),
  category: z.string().min(1),
  summary: trendSummarySchema.nullable(),
});

export const trendOverviewSchema = z.strictObject({
  ...trendWindowFields,
  entries: z.array(trendOverviewEntrySchema),
});

export const recipeTrendResponseSchema = z.strictObject({
  correlationId: z.uuid(),
  data: recipeTrendSchema,
});

export const trendOverviewResponseSchema = z.strictObject({
  correlationId: z.uuid(),
  data: trendOverviewSchema,
});

export type TrendRange = z.infer<typeof trendRangeSchema>;
export type TrendBucket = z.infer<typeof trendBucketSchema>;
export type TrendChange = z.infer<typeof trendChangeSchema>;
export type TrendSummary = z.infer<typeof trendSummarySchema>;
export type RecipeTrend = z.infer<typeof recipeTrendSchema>;
export type TrendOverviewEntry = z.infer<typeof trendOverviewEntrySchema>;
export type TrendOverview = z.infer<typeof trendOverviewSchema>;
export type RecipeTrendResponse = z.infer<typeof recipeTrendResponseSchema>;
export type TrendOverviewResponse = z.infer<typeof trendOverviewResponseSchema>;
