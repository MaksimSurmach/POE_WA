import { z } from 'zod';
import {
  factoryBatchSchema,
  factoryEventSchema,
  factoryEventsSchema,
  factoryInventorySchema,
  factorySaleSchema,
  factoryMetricsSchema,
  factoryProjectionSchema,
  factoryTransactionSchema,
} from '@poe-worksmith/domain';

const key = z.string().trim().min(1).max(200);
export const factoryCreateBatchInputSchema = z.strictObject({
  recipeId: key,
  recipeHash: key,
  league: key,
  plannedBudget: factoryTransactionSchema,
  notes: z.string().max(2000).default(''),
  forecastRunId: z.uuid().optional(),
  idempotencyKey: z.uuid(),
});
export const factoryAppendEventInputSchema = z.strictObject({
  expectedVersion: z.number().int().min(0).max(2000),
  idempotencyKey: z.uuid(),
  event: factoryEventSchema,
});
export const factoryBatchRecordSchema = z.strictObject({
  batch: factoryBatchSchema,
  events: factoryEventsSchema,
  projection: factoryProjectionSchema,
  version: z.number().int().min(0).max(2000),
});
export const factoryBatchSummaryRecordSchema = factoryBatchRecordSchema.omit({
  events: true,
});
export type FactoryBatchSummaryRecord = z.infer<
  typeof factoryBatchSummaryRecordSchema
>;
export const factoryBatchResponseSchema = z.strictObject({
  correlationId: z.string(),
  data: factoryBatchRecordSchema,
});
export const factoryBatchListResponseSchema = z.strictObject({
  correlationId: z.string(),
  data: z.strictObject({
    batches: z.array(factoryBatchSummaryRecordSchema).max(100),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(100),
  }),
});
export const factoryCoverageSchema = z.strictObject({
  complete: z.boolean(),
  totalBatches: z.number().int().nonnegative(),
  includedBatches: z.number().int().nonnegative(),
});
export const factoryInventoryResponseSchema = z.strictObject({
  correlationId: z.string(),
  data: z.strictObject({
    items: z.array(factoryInventorySchema),
    coverage: factoryCoverageSchema,
  }),
});
export const factorySalesResponseSchema = z.strictObject({
  correlationId: z.string(),
  data: z.strictObject({
    sales: z.array(factorySaleSchema),
    coverage: factoryCoverageSchema,
  }),
});
export const factorySummaryResponseSchema = z.strictObject({
  correlationId: z.string(),
  data: z.strictObject({
    accountingCurrency: z.literal('chaos'),
    metrics: factoryMetricsSchema,
    coverage: factoryCoverageSchema,
    asOf: z.iso.datetime({ offset: true }),
  }),
});
export type FactoryCreateBatchInput = z.infer<
  typeof factoryCreateBatchInputSchema
>;
export type FactoryAppendEventInput = z.infer<
  typeof factoryAppendEventInputSchema
>;
export type FactoryBatchRecord = z.infer<typeof factoryBatchRecordSchema>;
export type FactoryBatchResponse = z.infer<typeof factoryBatchResponseSchema>;
export type FactoryBatchListResponse = z.infer<
  typeof factoryBatchListResponseSchema
>;
export type FactoryInventoryResponse = z.infer<
  typeof factoryInventoryResponseSchema
>;
export type FactorySalesResponse = z.infer<typeof factorySalesResponseSchema>;
export type FactorySummaryResponse = z.infer<
  typeof factorySummaryResponseSchema
>;
