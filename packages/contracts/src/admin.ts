import { z } from 'zod';
import { intelligenceSettingsSchema } from '@poe-worksmith/domain';

export const marketAdminSettingsSchema = z.strictObject({
  intelligence: intelligenceSettingsSchema.default(() =>
    intelligenceSettingsSchema.parse({}),
  ),
  automaticRefreshEnabled: z.boolean(),
  scheduledCollectionEnabled: z.boolean(),
  collectionsPaused: z.boolean(),
  manualRefreshEnabled: z.boolean(),
  refreshCron: z.string().min(9).max(100),
  requestTimeoutMs: z.number().int().min(1000).max(30_000),
  collectionConcurrency: z.number().int().min(1).max(4),
  snapshotReuseTtlMs: z.number().int().min(1000).max(7_200_000),
  freshnessWarningMs: z.number().int().min(60_000).max(7_200_000),
  maximumQuoteAgeMs: z.number().int().min(60_000).max(7_200_000),
  rawRetentionHours: z.number().int().min(24).max(2160),
  historyRetentionDays: z.number().int().min(14).max(730),
});
export type MarketAdminSettings = z.infer<typeof marketAdminSettingsSchema>;
export const marketAdminPatchSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  settings: marketAdminSettingsSchema
    .partial()
    // Read defaults must not become writes when an unrelated setting is patched.
    .extend({ intelligence: intelligenceSettingsSchema.optional() })
    .refine((v) => Object.keys(v).length > 0),
});
export const marketAdminRefreshSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('all') }),
  z.strictObject({ scope: z.literal('economy') }),
  z.strictObject({
    scope: z.literal('recipe'),
    recipeId: z.string().min(1).max(200),
  }),
]);
export type MarketAdminRefresh = z.infer<typeof marketAdminRefreshSchema>;
export const marketAdminSettingsResponseSchema = z.object({
  version: z.number().int(),
  configured: marketAdminSettingsSchema,
  effective: marketAdminSettingsSchema,
  restartRequired: z.boolean(),
  applies: z.string(),
  timezone: z.string(),
  warnings: z.array(z.string()),
});
export type MarketAdminSettingsResponse = z.infer<
  typeof marketAdminSettingsResponseSchema
>;
export const marketAdminRunSchema = z.object({
  id: z.uuid(),
  scope: z.enum(['all', 'economy', 'recipe']),
  recipeId: z.string().nullable(),
  source: z.enum(['manual', 'scheduler']),
  status: z.enum([
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'skipped',
  ]),
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  cancelRequested: z.boolean(),
  errorCode: z.string().nullable(),
  durationMs: z.number().nullable(),
  completedQueries: z.number(),
  failedQueries: z.number(),
  totalQueries: z.number(),
  sourceFreshness: z.string().nullable(),
  cooldownUntil: z.string().nullable().optional(),
});
export type MarketAdminRun = z.infer<typeof marketAdminRunSchema>;
export const marketAdminStatusSchema = z.object({
  serverTime: z.string(),
  access: z.literal('local-only'),
  league: z.object({ name: z.string(), confirmed: z.boolean() }).nullable(),
  trade: z.object({
    configured: z.boolean(),
    status: z.string(),
    reason: z.string().nullable(),
  }),
  ninja: z.object({
    configured: z.boolean(),
    status: z.string(),
    cooldownUntil: z.string().nullable(),
  }),
  worker: z.object({
    healthy: z.boolean(),
    heartbeatAt: z.string().nullable(),
    settingsVersion: z.number().nullable(),
  }),
  scheduler: z.object({
    healthy: z.boolean(),
    enabled: z.boolean(),
    cron: z.string(),
    nextRefreshAt: z.string().nullable(),
  }),
  activeRun: marketAdminRunSchema.nullable(),
  lastSuccessful: marketAdminRunSchema.nullable(),
  lastFailed: marketAdminRunSchema.nullable(),
  collection: z.object({
    paused: z.boolean(),
    scheduled: z.boolean(),
    manualAvailable: z.boolean(),
  }),
  coverage: z.object({
    activeRecipes: z.number(),
    pricedRecipes: z.number(),
    freshRecipes: z.number(),
    warningRecipes: z.number(),
    latestSnapshotAt: z.string().nullable(),
  }),
  rateLimits: z.array(
    z.object({
      policy: z.string(),
      lastStatus: z.number().nullable(),
      waitingUntil: z.string(),
      minimumDelayMs: z.number(),
    }),
  ),
  warnings: z.array(z.string()),
});
export type MarketAdminStatus = z.infer<typeof marketAdminStatusSchema>;
