import { z } from 'zod';

export const marketAdminSettingsSchema = z.strictObject({
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
// Stored rows from earlier releases may still contain retired settings.
export const storedMarketAdminSettingsSchema =
  marketAdminSettingsSchema.strip();
export type MarketAdminSettings = z.infer<typeof marketAdminSettingsSchema>;
export const marketAdminPatchSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  settings: marketAdminSettingsSchema
    .partial()
    .refine((v) => Object.keys(v).length > 0),
});
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
