import { z } from 'zod';
import {
  outcomeModelSchema,
  outcomePriceQuoteSchema,
  outcomeValueQuoteSchema,
} from '@poe-worksmith/domain';

const key = z.string().trim().min(1).max(160);
const hash = z.string().trim().min(1).max(200);
const instant = z.iso.datetime({ offset: true });
export const craftModelSaveInputSchema = z.strictObject({
  recipeId: key,
  recipeHash: hash,
  league: key,
  expectedRevision: z.number().int().positive().nullable(),
  idempotencyKey: z.string().uuid(),
  currency: z.enum(['chaos', 'divine']),
  model: outcomeModelSchema,
  prices: z.record(key, outcomePriceQuoteSchema).default({}),
  valuations: z.record(key, outcomeValueQuoteSchema).default({}),
});
export const craftModelRecordSchema = craftModelSaveInputSchema
  .omit({
    expectedRevision: true,
    idempotencyKey: true,
  })
  .extend({
    id: z.uuid(),
    revision: z.number().int().positive(),
    leagueId: z.uuid(),
    targetSignature: hash,
    createdAt: instant,
  });
export const craftModelResponseSchema = z.strictObject({
  correlationId: z.string(),
  data: craftModelRecordSchema,
});
export type CraftModelSaveInput = z.infer<typeof craftModelSaveInputSchema>;
export type CraftModelRecord = z.infer<typeof craftModelRecordSchema>;

import {
  outcomeAnalysisSchema,
  riskSimulationRequestSchema,
  riskSimulationResultSchema,
} from '@poe-worksmith/domain';
export const craftRiskCreateInputSchema = z.strictObject({
  recipeId: key,
  recipeHash: hash,
  league: key,
  modelId: z.uuid(),
  idempotencyKey: z.uuid(),
  simulation: riskSimulationRequestSchema.omit({ analysis: true }),
});
export const craftRiskRunSchema = z.strictObject({
  id: z.uuid(),
  modelId: z.uuid(),
  recipeId: key,
  recipeHash: hash,
  leagueId: z.uuid(),
  calculationVersion: key,
  request: riskSimulationRequestSchema,
  status: z.enum([
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  progress: z.number().int().min(0).max(100),
  result: riskSimulationResultSchema.nullable(),
  error: z.string().nullable(),
  cancelRequested: z.boolean(),
  createdAt: instant,
  startedAt: instant.nullable(),
  finishedAt: instant.nullable(),
});
export const craftRiskResponseSchema = z.strictObject({
  correlationId: z.string(),
  data: craftRiskRunSchema,
});
export const craftAnalysisSchema = z.strictObject({
  recipeId: key,
  recipeHash: hash,
  targetSignature: hash,
  league: key.nullable(),
  leagueId: z.uuid().nullable(),
  evaluatedAt: instant,
  modelRecord: craftModelRecordSchema.nullable(),
  embeddedModel: outcomeModelSchema.nullable().default(null),
  analysis: outcomeAnalysisSchema.nullable(),
  prices: z.record(key, outcomePriceQuoteSchema),
  valuations: z.record(key, outcomeValueQuoteSchema),
  unavailableReasons: z.array(z.string()),
  canEdit: z.boolean(),
});
export const craftAnalysisResponseSchema = z.strictObject({
  correlationId: z.string(),
  data: craftAnalysisSchema,
});
export type CraftAnalysis = z.infer<typeof craftAnalysisSchema>;
export type CraftRiskCreateInput = z.infer<typeof craftRiskCreateInputSchema>;
export type CraftRiskRun = z.infer<typeof craftRiskRunSchema>;
