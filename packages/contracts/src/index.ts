import { z } from 'zod';

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
    errorCode: z.string().min(1).nullable(),
  })
  .strict();

/** Current or published full-catalog refresh progress. */
export const refreshCycleSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(['queued', 'running', 'published', 'failed']),
    startedAt: z.iso.datetime(),
    publishedAt: z.iso.datetime().nullable(),
    totalRecipes: z.number().int().nonnegative(),
    completedRecipes: z.number().int().nonnegative(),
    failedRecipes: z.number().int().nonnegative(),
  })
  .strict();

/** Example API-shaped catalog entry consumed by UI components. */
export const catalogEntrySchema = z
  .object({
    recipe: recipeSchema,
    evaluation: recipeEvaluationSchema,
    snapshot: marketSnapshotSchema.nullable(),
  })
  .strict();

export type Price = z.infer<typeof priceSchema>;
export type Listing = z.infer<typeof listingSchema>;
export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;
export type Recipe = z.infer<typeof recipeSchema>;
export type RecipeEvaluation = z.infer<typeof recipeEvaluationSchema>;
export type RefreshCycle = z.infer<typeof refreshCycleSchema>;
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
