import {
  domainErrorCategories,
  domainErrorCodes,
  domainErrorDefinitions,
  errorDispositions,
} from '@poe-worksmith/domain';
import { z } from 'zod';

export { domainErrorCodes, domainErrorDefinitions };
export const domainErrorCodeSchema = z.enum(domainErrorCodes);

/** A display price. Market normalization will later use chaos amounts. */
export const priceSchema = z
  .object({
    amount: z.number().finite().nonnegative(),
    currency: z.enum(['chaos', 'divine']),
  })
  .strict();

/** One raw market offer. Seller duplicates are intentionally valid. */
export const listingSchema = z
  .object({
    id: z.string().min(1),
    seller: z.string().min(1),
    price: priceSchema,
    indexedAt: z.iso.datetime(),
    ageSeconds: z.number().int().nonnegative(),
  })
  .strict();

/** Provider data before recipe economics are calculated. */
export const marketSnapshotSchema = z
  .object({
    id: z.string().min(1),
    queryHash: z.string().min(1),
    capturedAt: z.iso.datetime(),
    totalResults: z.number().int().nonnegative(),
    listings: z.array(listingSchema),
  })
  .strict();

/** Frontend recipe metadata independent of market and evaluation data. */
export const recipeSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    category: z.string().min(1),
    craftMethod: z.string().min(1),
    tags: z.array(z.string().min(1)),
    minimumCapital: priceSchema,
  })
  .strict();

/** Calculated catalog view; nullable values make loading/failure explicit. */
export const recipeEvaluationSchema = z
  .object({
    recipeId: z.string().min(1),
    status: z.enum(['success', 'stale', 'loading', 'partial', 'error']),
    evaluatedAt: z.iso.datetime().nullable(),
    expectedCraftCost: priceSchema.nullable(),
    estimatedSalePrice: priceSchema.nullable(),
    profit: priceSchema.nullable(),
    marginPercent: z.number().finite().nullable(),
    snapshotId: z.string().min(1).nullable(),
    lastSuccessfulAt: z.iso.datetime().nullable(),
    errorCode: domainErrorCodeSchema.nullable(),
  })
  .strict();

/** Current or published full-catalog refresh progress. */
export const refreshCycleSchema = z
  .object({
    completedQueries: z.number().int().nonnegative(),
    completedRecipes: z.number().int().nonnegative(),
    failedQueries: z.number().int().nonnegative(),
    failedRecipes: z.number().int().nonnegative(),
    finishedAt: z.iso.datetime().nullable(),
    id: z.string().min(1),
    publishedAt: z.iso.datetime().nullable(),
    requestedAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    status: z.enum(['queued', 'running', 'published', 'failed', 'superseded']),
    totalQueries: z.number().int().nonnegative(),
    totalRecipes: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((cycle, context) => {
    if (cycle.completedQueries + cycle.failedQueries > cycle.totalQueries) {
      context.addIssue({
        code: 'custom',
        message: 'Query progress exceeds totalQueries',
        path: ['completedQueries'],
      });
    }
    if (cycle.completedRecipes + cycle.failedRecipes > cycle.totalRecipes) {
      context.addIssue({
        code: 'custom',
        message: 'Recipe progress exceeds totalRecipes',
        path: ['completedRecipes'],
      });
    }
  });

/** Example API-shaped catalog entry consumed by UI components. */
export const catalogEntrySchema = z
  .object({
    recipe: recipeSchema,
    evaluation: recipeEvaluationSchema,
    snapshot: marketSnapshotSchema.nullable(),
  })
  .strict();

export const recipeDetailViewSchema = z
  .object({
    recipe: recipeSchema,
    gameVersion: z.string().min(1),
    confidence: z.enum(['low', 'medium', 'high']).nullable(),
    base: z
      .object({
        name: z.string().min(1),
        requirements: z.array(z.string().min(1)),
      })
      .strict(),
    materials: z.array(
      z
        .object({
          name: z.string().min(1),
          quantityPerAttempt: z.number().positive(),
          unitPrice: priceSchema,
          costPerAttempt: priceSchema,
        })
        .strict(),
    ),
    craftSteps: z.array(z.string().min(1)).min(1),
    requiredMods: z.array(z.string().min(1)),
    costBreakdown: z
      .object({
        baseCost: priceSchema,
        materialsPerAttempt: priceSchema,
        expectedAttempts: z.number().positive(),
        finishingCost: priceSchema,
        expectedCost: priceSchema,
      })
      .strict()
      .nullable(),
    estimators: z.array(
      z
        .object({
          id: z.string().min(1),
          label: z.string().min(1),
          price: priceSchema,
        })
        .strict(),
    ),
    selectedEstimatorId: z.string().min(1).nullable(),
    evaluation: recipeEvaluationSchema,
    snapshot: marketSnapshotSchema.nullable(),
  })
  .strict();

export const correlationIdSchema = z.uuid();
export const refreshStatusSchema = z.enum([
  'idle',
  'queued',
  'running',
  'published',
  'failed',
  'superseded',
]);

export const publicDomainErrorSchema = z
  .strictObject({
    category: z.enum(domainErrorCategories),
    code: domainErrorCodeSchema,
    disposition: z.enum(errorDispositions),
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .superRefine((error, context) => {
    const definition = domainErrorDefinitions[error.code];
    if (error.category !== definition.category) {
      context.addIssue({
        code: 'custom',
        message: 'Category does not match error code',
        path: ['category'],
      });
    }
    if (error.disposition !== definition.disposition) {
      context.addIssue({
        code: 'custom',
        message: 'Disposition does not match error code',
        path: ['disposition'],
      });
    }
    if (error.retryable !== (definition.disposition === 'retryable')) {
      context.addIssue({
        code: 'custom',
        message: 'Retry flag does not match error code',
        path: ['retryable'],
      });
    }
    if (error.message !== definition.publicMessage) {
      context.addIssue({
        code: 'custom',
        message: 'Message does not match the safe public error message',
        path: ['message'],
      });
    }
  });

export const apiErrorEnvelopeSchema = z.strictObject({
  correlationId: correlationIdSchema,
  error: publicDomainErrorSchema,
});

function resourceResponseSchema<T extends z.ZodType>(dataSchema: T) {
  const success = z.strictObject({
    correlationId: correlationIdSchema,
    data: dataSchema,
    errorCode: z.null(),
    isStale: z.literal(false),
    lastSuccessfulAt: z.iso.datetime(),
    publishedAt: z.iso.datetime(),
    refreshStatus: refreshStatusSchema,
    state: z.literal('success'),
  });
  const stale = z.strictObject({
    correlationId: correlationIdSchema,
    data: dataSchema,
    errorCode: domainErrorCodeSchema,
    isStale: z.literal(true),
    lastSuccessfulAt: z.iso.datetime(),
    publishedAt: z.iso.datetime(),
    refreshStatus: refreshStatusSchema,
    state: z.literal('stale'),
  });
  const partial = z.strictObject({
    correlationId: correlationIdSchema,
    data: dataSchema,
    errorCode: domainErrorCodeSchema,
    isStale: z.boolean(),
    lastSuccessfulAt: z.iso.datetime().nullable(),
    publishedAt: z.iso.datetime(),
    refreshStatus: refreshStatusSchema,
    state: z.literal('partial'),
  });
  const error = apiErrorEnvelopeSchema
    .safeExtend({
      data: z.null(),
      errorCode: domainErrorCodeSchema,
      isStale: z.boolean(),
      lastSuccessfulAt: z.iso.datetime().nullable(),
      publishedAt: z.iso.datetime().nullable(),
      refreshStatus: refreshStatusSchema,
      state: z.literal('error'),
    })
    .superRefine((response, context) => {
      if (response.errorCode !== response.error.code) {
        context.addIssue({
          code: 'custom',
          message: 'Error code must match the error envelope',
          path: ['errorCode'],
        });
      }
    });

  return z.union([success, stale, partial, error]);
}

export const catalogResponseSchema = resourceResponseSchema(
  z.strictObject({ entries: z.array(catalogEntrySchema) }),
);

export const recipeResponseSchema = resourceResponseSchema(
  recipeDetailViewSchema,
);

export const refreshProgressResponseSchema = z.strictObject({
  correlationId: correlationIdSchema,
  data: z.strictObject({
    active: refreshCycleSchema.nullable(),
    published: refreshCycleSchema.nullable(),
  }),
});

export const rateLimitWindowSchema = z.strictObject({
  activeRestrictionSeconds: z.number().int().nonnegative(),
  currentHits: z.number().int().nonnegative(),
  maximumHits: z.number().int().positive(),
  periodSeconds: z.number().int().positive(),
  restrictionSeconds: z.number().int().nonnegative(),
  rule: z.string().min(1),
});

export const rateLimitDiagnosticsResponseSchema = z.strictObject({
  correlationId: correlationIdSchema,
  data: z.strictObject({
    policies: z.array(
      z.strictObject({
        blockedUntil: z.iso.datetime(),
        endpoints: z.array(z.string().min(1)),
        lastResponseAt: z.iso.datetime().nullable(),
        lastStatus: z.number().int().min(100).max(599).nullable(),
        minimumDelayMs: z.number().int().positive(),
        nextRequestAt: z.iso.datetime(),
        policy: z.string().min(1),
        updatedAt: z.iso.datetime(),
        waitingUntil: z.iso.datetime(),
        windows: z.array(rateLimitWindowSchema),
      }),
    ),
  }),
});

export type Price = z.infer<typeof priceSchema>;
export type Listing = z.infer<typeof listingSchema>;
export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;
export type Recipe = z.infer<typeof recipeSchema>;
export type RecipeEvaluation = z.infer<typeof recipeEvaluationSchema>;
export type RefreshCycle = z.infer<typeof refreshCycleSchema>;
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
export type RecipeDetailView = z.infer<typeof recipeDetailViewSchema>;
export type PublicDomainError = z.infer<typeof publicDomainErrorSchema>;
export type DomainErrorCode = z.infer<typeof domainErrorCodeSchema>;
export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;
export type RefreshStatus = z.infer<typeof refreshStatusSchema>;
export type CatalogResponse = z.infer<typeof catalogResponseSchema>;
export type RecipeResponse = z.infer<typeof recipeResponseSchema>;
export type RefreshProgressResponse = z.infer<
  typeof refreshProgressResponseSchema
>;
export type RateLimitDiagnosticsResponse = z.infer<
  typeof rateLimitDiagnosticsResponseSchema
>;
