import { Decimal } from 'decimal.js';
import { z } from 'zod';

export const outcomeCalculationVersion = 'outcomes-1';
const id = z.string().trim().min(1).max(160);
const text = z.string().trim().min(1).max(2000);
export function isOutcomeAmount(value: string): boolean {
  return (
    value.length <= 40 &&
    /^(?:0|[1-9]\d*)(?:\.\d{1,16})?$/.test(value) &&
    new Decimal(value).lte('1e12')
  );
}
const decimal = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,16})?$/)
  .max(40)
  .refine(isOutcomeAmount, 'Value exceeds supported bound');
const probability = decimal.refine(
  (v) => isOutcomeAmount(v) && new Decimal(v).lte(1),
  'Probability exceeds one',
);
export const outcomeProvenanceSchema = z.strictObject({
  kind: z.enum([
    'verified-calculator',
    'mechanics',
    'market-observation',
    'transaction',
    'assumption',
  ]),
  reference: text,
  recordedAt: z.iso.datetime({ offset: true }),
  notes: text,
});
export const outcomeMatchingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('exact-target'), targetSignature: id }),
  z.strictObject({ kind: z.literal('manual'), description: text }),
]);
const marketEvidenceSchema = z.strictObject({
  league: id,
  observedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  coverage: z.enum(['complete', 'partial', 'unknown']),
  independentSellers: z.number().int().min(0).max(1000000).nullable(),
});
export const outcomePriceQuoteSchema = z.strictObject({
  amount: decimal,
  currency: id,
  provenance: outcomeProvenanceSchema,
  market: marketEvidenceSchema.optional(),
});
export const outcomeValueQuoteSchema = z
  .strictObject({
    min: decimal,
    max: decimal,
    currency: id,
    matching: outcomeMatchingSchema,
    provenance: outcomeProvenanceSchema,
    market: marketEvidenceSchema.optional(),
  })
  .refine(
    (v) =>
      isOutcomeAmount(v.min) &&
      isOutcomeAmount(v.max) &&
      new Decimal(v.min).lte(v.max),
    'Value range is reversed',
  );
export const outcomeCostSchema = z.strictObject({
  kind: z.enum(['base', 'material', 'finishing', 'recovery']),
  resourceId: id,
  quantity: decimal.nullable(),
  provenance: outcomeProvenanceSchema,
});
export const outcomeCreditSchema = z.strictObject({
  resourceId: id,
  quantity: decimal.nullable(),
  provenance: outcomeProvenanceSchema,
});
export const methodOutcomeSchema = z
  .strictObject({
    id,
    name: text,
    classification: z.enum([
      'premium',
      'target',
      'imperfect',
      'salvage',
      'unusable',
      'recovery',
    ]),
    probability: z.strictObject({
      value: probability.nullable(),
      provenance: outcomeProvenanceSchema.nullable(),
    }),
    nextStageId: id.nullable(),
    baseDisposition: z.enum(['retained', 'consumed']).default('consumed'),
    targetSuccess: z.boolean(),
    sellable: z.boolean(),
    matching: outcomeMatchingSchema,
    costs: z.array(outcomeCostSchema).max(32).default([]),
    credits: z.array(outcomeCreditSchema).max(32).default([]),
    unknowns: z.array(text).max(32).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.probability.value !== null && !v.probability.provenance)
      ctx.addIssue({
        code: 'custom',
        message: 'Numerical probability requires provenance',
        path: ['probability'],
      });
    if ((v.sellable || v.targetSuccess) && v.baseDisposition !== 'consumed')
      ctx.addIssue({
        code: 'custom',
        message: 'A sold or completed target item consumes its base',
        path: ['baseDisposition'],
      });
    if (v.nextStageId !== null && (v.sellable || v.targetSuccess))
      ctx.addIssue({
        code: 'custom',
        message: 'Only terminal outcomes can sell or complete the target',
        path: ['nextStageId'],
      });
  });
export const outcomeModelSchema = z
  .strictObject({
    version: z.literal(1),
    id,
    startStageId: id,
    // Initial base inputs belong to one produced item; donor bases belong in stage/transition costs.
    initialCosts: z.array(outcomeCostSchema).max(32).default([]),
    unknowns: z.array(text).max(32).default([]),
    stages: z
      .array(
        z.strictObject({
          id,
          name: text,
          costs: z.array(outcomeCostSchema).max(32).default([]),
          exclusivity: z.strictObject({
            mode: z.enum(['disjoint', 'precedence']),
            provenance: outcomeProvenanceSchema,
          }),
          outcomes: z.array(methodOutcomeSchema).min(1).max(16),
        }),
      )
      .min(1)
      .max(16),
  })
  .superRefine((v, ctx) => {
    const stages = new Set(v.stages.map((s) => s.id));
    if (stages.size !== v.stages.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Stage IDs must be unique',
        path: ['stages'],
      });
    if (!stages.has(v.startStageId))
      ctx.addIssue({
        code: 'custom',
        message: 'Starting stage does not exist',
        path: ['startStageId'],
      });
    const outcomes = new Set<string>();
    v.stages.forEach((stage, si) => {
      let total = new Decimal(0);
      let known = true;
      const exactTargets = new Set<string>();
      stage.outcomes.forEach((outcome, oi) => {
        if (outcomes.has(outcome.id))
          ctx.addIssue({
            code: 'custom',
            message: 'Outcome IDs must be globally unique',
            path: ['stages', si, 'outcomes', oi, 'id'],
          });
        outcomes.add(outcome.id);
        if (outcome.nextStageId !== null && !stages.has(outcome.nextStageId))
          ctx.addIssue({
            code: 'custom',
            message: 'Next stage does not exist',
            path: ['stages', si, 'outcomes', oi, 'nextStageId'],
          });
        if (
          outcome.probability.value === null ||
          !isOutcomeAmount(outcome.probability.value)
        )
          known = false;
        else {
          total = total.add(outcome.probability.value);
          if (
            outcome.matching.kind === 'exact-target' &&
            new Decimal(outcome.probability.value).gt(0)
          ) {
            if (exactTargets.has(outcome.matching.targetSignature))
              ctx.addIssue({
                code: 'custom',
                message:
                  'Positive-probability outcome categories overlap: identical exact target',
                path: ['stages', si, 'outcomes', oi, 'matching'],
              });
            exactTargets.add(outcome.matching.targetSignature);
          }
        }
      });
      if (total.gt(1) || (known && !total.eq(1)))
        ctx.addIssue({
          code: 'custom',
          message:
            'Conditional probabilities must sum exactly to one; represent unknown residual explicitly',
          path: ['stages', si, 'outcomes'],
        });
    });
  });
export const outcomeAnalysisInputSchema = z.strictObject({
  model: outcomeModelSchema,
  currency: id,
  league: id,
  now: z.iso.datetime({ offset: true }),
  prices: z.record(id, outcomePriceQuoteSchema),
  valuations: z.record(id, outcomeValueQuoteSchema),
});
export type OutcomeProvenance = z.infer<typeof outcomeProvenanceSchema>;
export type OutcomeMatching = z.infer<typeof outcomeMatchingSchema>;
export type OutcomePriceQuote = z.infer<typeof outcomePriceQuoteSchema>;
export type OutcomeValueQuote = z.infer<typeof outcomeValueQuoteSchema>;
export type OutcomeCost = z.infer<typeof outcomeCostSchema>;
export type OutcomeCredit = z.infer<typeof outcomeCreditSchema>;
export type MethodOutcome = z.infer<typeof methodOutcomeSchema>;
export type OutcomeModel = z.infer<typeof outcomeModelSchema>;
export type OutcomeAnalysisInput = z.infer<typeof outcomeAnalysisInputSchema>;
