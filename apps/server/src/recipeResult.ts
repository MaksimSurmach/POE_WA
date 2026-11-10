import { domainErrorCodeSchema } from '@poe-worksmith/contracts';
import { z } from 'zod';

const amount = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i)
  .refine((value) => Number.isFinite(Number(value)));
const currency = z.string().min(1);

export const recipeResultSchema = z.strictObject({
  confidence: z.enum(['low', 'medium', 'high']).nullable(),
  currency: currency.nullable(),
  errorCode: domainErrorCodeSchema.nullable(),
  estimatedSalePrice: amount.nullable(),
  expectedCraftCost: amount.nullable(),
  marginPercent: amount.nullable(),
  profit: amount.nullable(),
  status: z.enum(['success', 'partial', 'error']),
  methodCost: z
    .object({
      oldestInputAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      craftInputAt: z.iso.datetime().optional(),
      craftExpiresAt: z.iso.datetime().optional(),
      source: z
        .strictObject({
          captureId: z.uuid(),
          captureFxSnapshotId: z.uuid().nullable(),
          capturedAt: z.iso.datetime(),
          sampleSize: z.number().int().nonnegative(),
          priceBasis: z.literal('asking'),
          coverage: z.enum(['complete', 'partial', 'unknown']),
          sortedPageComplete: z.boolean(),
          sortedSampleComplete: z.boolean(),
          currencyAvailable: z.boolean(),
        })
        .optional(),
      marketStatus: z.enum(['unavailable', 'partial', 'priced', 'empty']),
      saleEvidence: z
        .object({
          comparableSellers: z.number().int().nonnegative(),
          grade: z.enum(['A', 'B', 'C']).optional(),
          gradeReasons: z.array(z.string()).optional(),
          reason: z.string().optional(),
        })
        .catchall(z.json()),
      budget: z.strictObject({ p50: amount, p90: amount, currency }).nullable(),
    })
    .catchall(z.json())
    .nullable(),
});

export type RecipeResult = z.infer<typeof recipeResultSchema>;
