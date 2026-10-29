import { z } from 'zod';

const text = (maximum = 200) => z.string().trim().min(1).max(maximum);
const httpsUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  }, 'Use an HTTPS URL without credentials');

export const marketSourceEvidenceSchema = z.strictObject({
  title: text(),
  url: httpsUrl,
  kind: z.enum(['guide', 'video', 'reddit', 'pob', 'manual']),
  notes: z.string().trim().max(4000).optional(),
});

/** A user-curated demand hypothesis. Mod text is not an executable trade query. */
export const marketTargetInputSchema = z.strictObject({
  name: text(),
  game: z.literal('poe1'),
  realm: z.literal('pc'),
  league: text(100),
  patch: text(50),
  slot: text(100),
  baseTypes: z.array(text()).min(1).max(30),
  builds: z.array(text()).max(30),
  requiredMods: z.array(text(500)).max(30),
  minItemLevel: z.number().int().min(1).max(100).nullable().optional(),
  qualityMin: z.number().int().min(0).max(100).nullable().optional(),
  influences: z.array(text(100)).max(10).optional(),
  corrupted: z.boolean().nullable().optional(),
  sources: z.array(marketSourceEvidenceSchema).max(30),
});

export const marketTargetSchema = marketTargetInputSchema.extend({
  id: z.uuid(),
  version: z.literal(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
});

export const marketImportListingSchema = z.strictObject({
  externalId: text(256).optional(),
  price: z.number().finite().positive().max(1_000_000_000),
  item: z.record(z.string(), z.json()),
});

/** All rows share one currency. They are selected by the importer, not matched by an engine. */
export const marketSnapshotImportSchema = z
  .strictObject({
    targetId: z.uuid(),
    capturedAt: z.iso.datetime(),
    sourceUrl: httpsUrl,
    notes: z.string().trim().max(4000).optional(),
    currency: z.enum(['chaos', 'divine']),
    dataKind: z.enum(['observed', 'demo']),
    emptyResult: z.boolean().optional(),
    listings: z.array(marketImportListingSchema).max(1000),
  })
  .superRefine((input, context) => {
    if (input.listings.length === 0 && input.emptyResult !== true) {
      context.addIssue({
        code: 'custom',
        path: ['emptyResult'],
        message:
          'Confirm emptyResult=true for a successful observation with no listings',
      });
    }
    if (input.listings.length > 0 && input.emptyResult === true) {
      context.addIssue({
        code: 'custom',
        path: ['emptyResult'],
        message: 'An empty result cannot contain listings',
      });
    }
    const ids = new Set<string>();
    input.listings.forEach((listing, index) => {
      if (!listing.externalId) return;
      if (ids.has(listing.externalId)) {
        context.addIssue({
          code: 'custom',
          path: ['listings', index, 'externalId'],
          message: 'Duplicate listing identity in the same observation',
        });
      }
      ids.add(listing.externalId);
    });
  });

const optionalPrice = z.number().finite().positive().nullable();
export const marketResearchSnapshotSummarySchema = z.strictObject({
  id: z.uuid(),
  targetId: z.uuid(),
  targetVersion: z.literal(1),
  targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  game: z.literal('poe1'),
  realm: z.literal('pc'),
  league: text(100),
  patch: text(50),
  capturedAt: z.iso.datetime(),
  retrievedAt: z.iso.datetime(),
  sourceUrl: httpsUrl,
  notes: z.string().max(4000).optional(),
  provenance: z.literal('manual_import'),
  comparability: z.literal('user_selected'),
  currency: z.enum(['chaos', 'divine']),
  dataKind: z.enum(['observed', 'demo']),
  outcome: z.enum(['observed', 'no_listings']),
  count: z.number().int().min(0).max(1000),
  rejectedCount: z.literal(0),
  p25: optionalPrice,
  median: optionalPrice,
  p75: optionalPrice,
});

export const marketResearchSnapshotSchema =
  marketResearchSnapshotSummarySchema.extend({
    listings: z.array(marketImportListingSchema).max(1000),
  });

export const marketSourceCapabilitySchema = z.strictObject({
  id: text(100),
  name: text(),
  status: z.enum([
    'available',
    'planned',
    'requires_approval',
    'manual_only',
    'unsupported',
  ]),
  description: text(1500),
  documentationUrl: httpsUrl,
});

export const marketWorkbenchResponseSchema = z.strictObject({
  correlationId: z.uuid(),
  data: z.strictObject({
    storage: z.enum(['postgres', 'unavailable']),
    targets: z.array(marketTargetSchema),
    snapshots: z.array(marketResearchSnapshotSummarySchema),
    sources: z.array(marketSourceCapabilitySchema),
  }),
});

export const marketTargetResponseSchema = z.strictObject({
  correlationId: z.uuid(),
  data: marketTargetSchema,
});

export const marketResearchSnapshotResponseSchema = z.strictObject({
  correlationId: z.uuid(),
  data: marketResearchSnapshotSchema,
});

export type MarketSourceEvidence = z.infer<typeof marketSourceEvidenceSchema>;
export type MarketTargetInput = z.infer<typeof marketTargetInputSchema>;
export type MarketTarget = z.infer<typeof marketTargetSchema>;
export type MarketImportListing = z.infer<typeof marketImportListingSchema>;
export type MarketSnapshotImport = z.infer<typeof marketSnapshotImportSchema>;
export type MarketResearchSnapshotSummary = z.infer<
  typeof marketResearchSnapshotSummarySchema
>;
export type MarketResearchSnapshot = z.infer<
  typeof marketResearchSnapshotSchema
>;
export type MarketSourceCapability = z.infer<
  typeof marketSourceCapabilitySchema
>;
export type MarketWorkbenchResponse = z.infer<
  typeof marketWorkbenchResponseSchema
>;

export const marketEconomyCategorySchema = z.enum([
  'BaseType',
  'Currency',
  'Essence',
  'Fossil',
  'Resonator',
]);
export const marketEconomyCollectInputSchema = z.strictObject({
  league: text(100),
  category: marketEconomyCategorySchema,
});
export const marketEconomyLineSchema = z.strictObject({
  id: text(500),
  name: z.string().nullable(),
  detailsId: z.string().nullable(),
  baseType: z.string().nullable(),
  price: z.strictObject({
    amount: z.number().finite().positive().nullable(),
    currency: text(500),
  }),
  listingCount: z.number().int().nonnegative().nullable(),
  observationCount: z.number().int().nonnegative().nullable(),
  tradedVolume: z
    .strictObject({
      amount: z.number().finite().nonnegative(),
      currency: text(500),
    })
    .nullable(),
});
export const marketEconomySummarySchema = z.strictObject({
  id: z.uuid(),
  schemaVersion: z.literal(1),
  source: z.literal('poe.ninja'),
  game: z.literal('poe1'),
  league: text(100),
  category: marketEconomyCategorySchema,
  endpoint: httpsUrl,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  capturedAt: z.iso.datetime(),
  sourceUpdatedAt: z.null(),
  priceBasis: z.enum(['stash-estimate', 'currency-exchange']),
  lineCount: z.number().int().nonnegative().max(100_000),
  payloadAvailable: z.boolean(),
});
export const marketEconomyAttemptSchema = z.strictObject({
  id: z.uuid(),
  league: text(100),
  category: marketEconomyCategorySchema,
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  status: z.enum(['running', 'succeeded', 'failed', 'interrupted']),
  cacheStatus: z.enum(['fetched', 'hit', 'revalidated']).nullable(),
  errorCode: text(100).nullable(),
  snapshotId: z.uuid().nullable(),
});
export const marketEconomyDetailSchema = marketEconomySummarySchema.extend({
  lines: z.array(marketEconomyLineSchema).max(200),
  truncated: z.boolean(),
});
export const marketEconomyOverviewResponseSchema = z.strictObject({
  correlationId: z.uuid(),
  data: z.strictObject({
    configured: z.boolean(),
    storage: z.enum(['postgres', 'unavailable']),
    snapshots: z.array(marketEconomySummarySchema).max(100),
    attempts: z.array(marketEconomyAttemptSchema).max(100),
    limit: z.literal(100),
  }),
});
export const marketEconomyLeaguesResponseSchema = z.strictObject({
  correlationId: z.uuid(),
  data: z.strictObject({
    leagues: z
      .array(z.strictObject({ id: text(100), name: text(200) }))
      .max(100),
    checkedAt: z.iso.datetime(),
    nextRefreshAt: z.iso.datetime(),
  }),
});
export const marketEconomyCollectResponseSchema = z.strictObject({
  correlationId: z.uuid(),
  data: z.strictObject({
    snapshot: marketEconomyDetailSchema,
    cacheStatus: z.enum(['fetched', 'hit', 'revalidated']),
    checkedAt: z.iso.datetime(),
    nextRefreshAt: z.iso.datetime(),
  }),
});
export const marketEconomyDetailResponseSchema = z.strictObject({
  correlationId: z.uuid(),
  data: marketEconomyDetailSchema,
});
export type MarketEconomyCategory = z.infer<typeof marketEconomyCategorySchema>;
export type MarketEconomySummary = z.infer<typeof marketEconomySummarySchema>;
export type MarketEconomyAttempt = z.infer<typeof marketEconomyAttemptSchema>;
export type MarketEconomyDetail = z.infer<typeof marketEconomyDetailSchema>;
export type MarketEconomyOverviewResponse = z.infer<
  typeof marketEconomyOverviewResponseSchema
>;
