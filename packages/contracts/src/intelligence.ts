import { z } from 'zod';
import {
  liquidityAssessmentSchema,
  opportunitySignalSchema,
  capitalAllocationRequestSchema,
  capitalAllocationPlanSchema,
} from '@poe-worksmith/domain';
const key = z.string().min(1).max(200);
export const opportunityViewSchema = z.strictObject({
  recipeId: key,
  title: key,
  category: key,
  targetSignature: key,
  signal: opportunitySignalSchema,
  liquidity: liquidityAssessmentSchema,
  availableRiskOptions: z.array(
    z.strictObject({
      id: key,
      currency: z.enum(['chaos', 'divine']),
      objective: z.strictObject({
        kind: z.enum(['attempts', 'successes', 'single-target']),
        count: z.number().int().positive(),
      }),
      p90: z.string().nullable(),
      p95: z.string().nullable(),
      expectedProfit: z.string().nullable(),
    }),
  ),
  reasons: z.array(z.string()),
});
export const opportunitiesResponseSchema = z.strictObject({
  correlationId: z.string(),
  data: z.strictObject({
    league: key,
    asOf: z.iso.datetime({ offset: true }),
    opportunities: z.array(opportunityViewSchema),
    coverage: z.strictObject({
      complete: z.boolean(),
      totalRecipes: z.number().int().nonnegative(),
      includedRecipes: z.number().int().nonnegative(),
    }),
  }),
});
export const opportunityResponseSchema = z.strictObject({
  correlationId: z.string(),
  data: opportunityViewSchema,
});
export const liquidityResponseSchema = z.strictObject({
  correlationId: z.string(),
  data: liquidityAssessmentSchema,
});
export const capitalPlanCreateInputSchema =
  capitalAllocationRequestSchema.safeExtend({ idempotencyKey: z.uuid() });
export const savedCapitalPlanSchema = z.strictObject({
  id: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  plan: capitalAllocationPlanSchema,
});
export const capitalPlanResponseSchema = z.strictObject({
  correlationId: z.string(),
  data: savedCapitalPlanSchema,
});
export type OpportunityView = z.infer<typeof opportunityViewSchema>;
export type OpportunitiesResponse = z.infer<typeof opportunitiesResponseSchema>;
export type OpportunityResponse = z.infer<typeof opportunityResponseSchema>;
export type CapitalPlanCreateInput = z.infer<
  typeof capitalPlanCreateInputSchema
>;
export type CapitalPlanResponse = z.infer<typeof capitalPlanResponseSchema>;

export const signalHistoryResponseSchema = z.strictObject({
  correlationId: z.string(),
  data: z.strictObject({
    decisions: z
      .array(
        z.strictObject({
          id: z.string(),
          createdAt: z.iso.datetime({ offset: true }),
          signal: opportunitySignalSchema,
        }),
      )
      .max(100),
  }),
});
export type SignalHistoryResponse = z.infer<typeof signalHistoryResponseSchema>;
