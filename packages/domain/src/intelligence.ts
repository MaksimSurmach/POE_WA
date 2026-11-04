import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { outcomeAnalysisInputSchema } from './outcomeModel.js';
import { outcomeAnalysisSchema } from './outcomeEconomics.js';
import {
  riskSimulationRequestSchema,
  riskSimulationResultSchema,
} from './craftingRisk.js';
import {
  factoryInventorySchema,
  factorySaleSchema,
  factoryTransactionSchema,
} from './factoryLedger.js';
const D = Decimal.clone({ precision: 120 });
const key = z.string().trim().min(1).max(200),
  instant = z.iso.datetime({ offset: true });
const amount = z
  .string()
  .refine(
    (v) =>
      v.length <= 80 && /^\d+(?:\.\d{1,48})?$/.test(v) && new D(v).lte('1e40'),
    'Invalid amount',
  );
const signed = z
  .string()
  .refine(
    (v) =>
      v.length <= 81 &&
      /^-?\d+(?:\.\d{1,48})?$/.test(v) &&
      new D(v).abs().lte('1e40'),
    'Invalid signed amount',
  );
const fraction = z.number().min(0).max(1);
const shockPercent = z
  .string()
  .refine(
    (v) =>
      v.length <= 16 && /^\d+(?:\.\d{1,8})?$/.test(v) && new D(v).lte(1000),
    'Shock must be a percentage between 0 and 1000 with at most 8 decimal places',
  );
export const intelligenceVersion = 'intelligence-1';
export const intelligenceSettingsSchema = z
  .strictObject({
    maxSnapshotAgeSeconds: z.number().int().min(60).max(604800).default(3600),
    minIndependentSellers: z.number().int().min(2).max(100).default(2),
    minConfirmations: z.number().int().min(2).max(10).default(2),
    minObservationGapSeconds: z.number().int().min(1).max(86400).default(60),
    cooldownSeconds: z.number().int().min(0).max(604800).default(3600),
    enterProfitChaos: amount.default('10'),
    exitProfitChaos: amount.default('0'),
    enterRiskAdjustedRoiPercent: amount.default('10'),
    exitRiskAdjustedRoiPercent: amount.default('5'),
    maxLossProbability: fraction.default(0.25),
    maxSellerShare: fraction.default(0.75),
    materialMovePercent: amount.default('10'),
    askMovePercent: amount.default('10'),
    sellerMovePercent: amount.default('25'),
    supplyGrowthPercent: amount.default('25'),
    minOwnSaleSamples: z.number().int().min(3).max(100).default(3),
    ownSalesWindowDays: z.number().int().min(1).max(365).default(30),
    conservativeRiskFraction: fraction.default(0.5),
    balancedRiskFraction: fraction.default(0.75),
    inputShockPercent: shockPercent.default('10'),
  })
  .refine(
    (p) =>
      new D(p.enterProfitChaos).gte(p.exitProfitChaos) &&
      new D(p.enterRiskAdjustedRoiPercent).gte(p.exitRiskAdjustedRoiPercent) &&
      p.conservativeRiskFraction <= p.balancedRiskFraction,
    'Entry thresholds and scenario risk fractions must be ordered',
  );
export type IntelligenceSettings = z.infer<typeof intelligenceSettingsSchema>;
export const intelligenceCohortSchema = z.strictObject({
  league: key,
  targetSignature: key,
  currency: z.literal('chaos'),
});
export const liquiditySnapshotSchema = z.strictObject({
  id: key,
  cohort: intelligenceCohortSchema,
  queryHash: key,
  capturedAt: instant,
  expiresAt: instant,
  coverage: z.enum(['complete', 'partial', 'unknown']),
  sortedSampleComplete: z.boolean(),
  totalListings: z.number().int().nonnegative(),
  listings: z
    .array(
      z.strictObject({
        id: key,
        seller: key,
        askChaos: amount,
        indexedAt: instant,
      }),
    )
    .max(2000),
});
export const liquidityInputSchema = z.strictObject({
  cohort: intelligenceCohortSchema,
  now: instant,
  snapshots: z.array(liquiditySnapshotSchema).max(20),
  ownSales: z.array(factorySaleSchema).max(10000),
  ownInventory: z.array(factoryInventorySchema).max(10000),
  ownCoverageComplete: z.boolean(),
  settings: intelligenceSettingsSchema,
});
export const liquidityAssessmentSchema = z.strictObject({
  cohort: intelligenceCohortSchema,
  status: z.enum(['supported', 'partial', 'unavailable']),
  reasons: z.array(z.string()),
  snapshotId: key.nullable(),
  observedAt: instant.nullable(),
  expiresAt: instant.nullable(),
  evidenceIds: z.array(key),
  coverage: z.enum(['complete', 'partial', 'unknown']),
  independentObservations: z.number().int().nonnegative(),
  sellers: z.number().int().nonnegative(),
  listings: z.number().int().nonnegative(),
  totalListings: z.number().int().nonnegative(),
  asking: z
    .strictObject({
      min: amount,
      p25: amount,
      median: amount,
      p75: amount,
      max: amount,
    })
    .nullable(),
  depth: z.array(
    z.strictObject({ ask: amount, listings: z.number().int().nonnegative() }),
  ),
  largestSellerShare: fraction.nullable(),
  concentrationIndex: fraction.nullable(),
  competitionTrend: z.enum(['rising', 'falling', 'stable', 'unknown']),
  changes: z
    .strictObject({
      new: z.number().int().nonnegative(),
      reappeared: z.number().int().nonnegative(),
      missing: z.number().int().nonnegative(),
      supplyPercent: signed.nullable(),
      sellerPercent: signed.nullable(),
      askPercent: signed.nullable(),
    })
    .nullable(),
  own: z.strictObject({
    coverageComplete: z.boolean(),
    sampleSize: z.number().int().nonnegative(),
    saleTimeSampleSize: z.number().int().nonnegative(),
    medianSellSeconds: z.number().nonnegative().nullable(),
    p75SellSeconds: z.number().nonnegative().nullable(),
    medianHoldingSeconds: z.number().nonnegative().nullable(),
    p75HoldingSeconds: z.number().nonnegative().nullable(),
    unsoldCount: z.number().int().nonnegative(),
    oldestUnsoldSeconds: z.number().nonnegative().nullable(),
    confirmedSales: z.array(
      z.strictObject({
        id: key,
        soldAt: instant,
        timeToSellSeconds: z.number().nonnegative().nullable(),
        holdingSeconds: z.number().nonnegative().nullable(),
      }),
    ),
    windowStart: instant,
    windowEnd: instant,
  }),
  basis: z.literal('listing-supply-proxies-and-own-confirmed-sales'),
});
export type LiquidityInput = z.infer<typeof liquidityInputSchema>;
export type LiquidityAssessment = z.infer<typeof liquidityAssessmentSchema>;
export const intelligenceRiskOptionSchema = z.strictObject({
  id: key,
  recipeId: key,
  recipeHash: key,
  targetSignature: key,
  league: key,
  createdAt: instant,
  request: riskSimulationRequestSchema,
  result: riskSimulationResultSchema,
});
export type IntelligenceRiskOption = z.infer<
  typeof intelligenceRiskOptionSchema
>;
export const signalStateNameSchema = z.enum([
  'CRAFT',
  'WATCH',
  'STOP',
  'INSUFFICIENT_DATA',
]);
export const opportunityEvidenceSchema = z.strictObject({
  recipeId: key,
  recipeHash: key,
  cohort: intelligenceCohortSchema,
  observationId: key.nullable(),
  observedAt: instant.nullable(),
  analysisInput: outcomeAnalysisInputSchema.nullable(),
  analysis: outcomeAnalysisSchema.nullable(),
  risk: intelligenceRiskOptionSchema.nullable(),
  liquidity: liquidityAssessmentSchema,
  additionalLiquidities: z.array(liquidityAssessmentSchema).default([]),
});
export const opportunitySignalSchema = z.strictObject({
  version: z.literal(intelligenceVersion),
  recipeId: key,
  recipeHash: key,
  cohort: intelligenceCohortSchema,
  state: signalStateNameSchema,
  candidate: signalStateNameSchema,
  confirmations: z.number().int().nonnegative(),
  hysteresisArmed: z.boolean().default(false),
  confirmationBasis: z.string().max(10000),
  lastObservationId: key.nullable(),
  lastObservedAt: instant.nullable(),
  lastEmittedAt: instant.nullable(),
  evaluatedAt: instant,
  emit: z.boolean(),
  triggers: z.array(key),
  reasons: z.array(z.string()),
  evidenceIds: z.array(key),
  metrics: z.strictObject({
    profit: signed.nullable(),
    materialCost: amount.nullable(),
    ask: amount.nullable(),
    sellers: z.number().int().nonnegative(),
    listings: z.number().int().nonnegative(),
    riskAdjustedRoiPercent: signed.nullable(),
  }),
});
export type OpportunityEvidence = z.infer<typeof opportunityEvidenceSchema>;
export type OpportunitySignal = z.infer<typeof opportunitySignalSchema>;
export const capitalAllocationRequestSchema = z
  .strictObject({
    league: key,
    capital: factoryTransactionSchema,
    reserve: factoryTransactionSchema,
    maxRiskProbability: fraction,
    maxExposurePercent: z.number().gt(0).lte(100),
    horizonDays: z.number().int().min(1).max(365),
    recipeIds: z.array(key).max(100).optional(),
    categories: z.array(key).max(100).optional(),
  })
  .refine(
    (v) =>
      v.capital.currency === v.reserve.currency &&
      v.capital.chaosPerUnit === v.reserve.chaosPerUnit,
    'Capital and reserve must use the same denomination and locked planning conversion',
  );
export const capitalCandidateSchema = z.strictObject({
  recipeId: key,
  recipeHash: key,
  title: key,
  category: key,
  targetSignature: key,
  league: key,
  signal: opportunitySignalSchema,
  analysisInput: outcomeAnalysisInputSchema.nullable(),
  analysis: outcomeAnalysisSchema.nullable(),
  liquidity: liquidityAssessmentSchema,
  additionalLiquidities: z.array(liquidityAssessmentSchema).default([]),
  options: z.array(intelligenceRiskOptionSchema).max(20),
});
export const allocationLineSchema = z.strictObject({
  recipeId: key,
  title: key,
  targetSignature: key,
  riskRunId: key,
  objective: riskSimulationResultSchema.shape.objective,
  plannedCapital: amount,
  expectedProfit: signed,
  p90Budget: amount,
  p95Budget: amount,
  lossProbabilityUpperBound: fraction,
  budgetExceedanceUpperBound: fraction,
  combinedRiskUpperBound: fraction,
  holdingDays: z.number().nonnegative(),
  ownSaleSamples: z.number().int().nonnegative(),
  liquidityCapacity: z.number().int().nonnegative(),
  reason: z.string(),
  stopCondition: z.string(),
});
export const allocationScenarioSchema = z.strictObject({
  name: z.enum(['conservative', 'balanced', 'aggressive']),
  lines: z.array(allocationLineSchema),
  allocatedCapital: amount,
  reservedCapital: amount,
  expectedProfit: signed,
  unionRiskUpperBound: fraction,
  statisticalConfidenceLowerBound: fraction,
  status: z.enum(['plan', 'hold']),
  watchlist: z.array(
    z.strictObject({ recipeId: key, reasons: z.array(z.string()) }),
  ),
  sensitivity: z.strictObject({
    inputShockPercent: amount,
    plannedCapital: amount,
    expectedProfit: signed,
    fitsCapital: z.boolean(),
    assumption: z.string(),
  }),
  limitations: z.array(z.string()),
});
export const capitalAllocationPlanSchema = z.strictObject({
  version: z.literal(intelligenceVersion),
  evaluatedAt: instant,
  request: capitalAllocationRequestSchema,
  scenarios: z.array(allocationScenarioSchema).length(3),
  evidenceIds: z.array(key),
});
export type CapitalAllocationRequest = z.infer<
  typeof capitalAllocationRequestSchema
>;
export type CapitalCandidate = z.infer<typeof capitalCandidateSchema>;
export type CapitalAllocationPlan = z.infer<typeof capitalAllocationPlanSchema>;
