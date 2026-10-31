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

/** Explicit, versioned rules; free-form guide text is never treated as a matcher. */
const beltRuleFields = {
  minItemLevel: z.number().int().min(1).max(100),
  influences: z.array(text(100)).max(10),
  corrupted: z.boolean(),
  mods: z
    .array(
      z.strictObject({
        id: text(200),
        minValue: z.number().finite(),
        maxTier: z.number().int().positive().optional(),
      }),
    )
    .min(1)
    .max(30),
};
export const beltRulesSchema = z.discriminatedUnion('version', [
  z.strictObject({ version: z.literal(1), ...beltRuleFields }),
  z.strictObject({
    version: z.literal(2),
    ...beltRuleFields,
    totalElementalResistanceMin: z.number().finite().nonnegative(),
  }),
  z.strictObject({
    version: z.literal(3),
    ...beltRuleFields,
    minItemLevel: beltRuleFields.minItemLevel.nullable(),
    influences: beltRuleFields.influences.nullable(),
    corrupted: beltRuleFields.corrupted.nullable(),
    totalElementalResistanceMin: z.number().finite().nonnegative().nullable(),
  }),
]);

export const beltPriceEvidenceSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('manual'),
    amount: z.number().finite().positive(),
    currency: z.enum(['chaos', 'divine']),
    league: text(100),
    patch: text(50),
    capturedAt: z.iso.datetime(),
    dataKind: z.enum(['observed', 'demo']),
    url: httpsUrl,
    notes: text(1000),
  }),
  z.strictObject({
    source: z.literal('economy'),
    snapshotId: z.uuid(),
    lineId: text(500),
    patch: text(50),
  }),
]);

export const beltPriceUpdateInputSchema = z.strictObject({
  targetId: z.uuid(),
  dataKind: z.enum(['observed', 'demo']),
  basePrice: beltPriceEvidenceSchema,
  materialPrices: z.record(z.string(), beltPriceEvidenceSchema),
});
export const beltPriceUpdateSchema = beltPriceUpdateInputSchema.extend({
  id: z.uuid(),
  targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
});
export const beltPriceUpdatesResponseSchema = z.strictObject({
  correlationId: z.uuid(),
  data: z.array(beltPriceUpdateSchema),
});
export type BeltPriceUpdate = z.infer<typeof beltPriceUpdateSchema>;
export type BeltPriceUpdateInput = z.infer<typeof beltPriceUpdateInputSchema>;

export const beltCraftMethodSchema = z
  .strictObject({
    version: z.literal(1),
    name: text(),
    sourceUrl: httpsUrl,
    assumptions: text(2000),
    steps: z.array(text(500)).min(1).max(20),
    rulesComplete: z.boolean(),
    repeatOnSameBase: z.literal(true),
    success: z.discriminatedUnion('mode', [
      z.strictObject({
        mode: z.literal('probability'),
        probability: z.number().gt(0).lte(1),
      }),
      z.strictObject({
        mode: z.literal('expected_attempts'),
        expectedAttempts: z.number().gte(1).finite(),
      }),
    ]),
    basePrice: beltPriceEvidenceSchema,
    materials: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          label: text(),
          quantityPerAttempt: z.number().finite().positive(),
          price: beltPriceEvidenceSchema,
        }),
      )
      .min(1)
      .max(20),
  })
  .superRefine((method, context) => {
    if (
      new Set(method.materials.map((material) => material.id)).size !==
      method.materials.length
    )
      context.addIssue({
        code: 'custom',
        path: ['materials'],
        message: 'Duplicate material IDs',
      });
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
  beltRules: beltRulesSchema.optional(),
  beltCraftMethod: beltCraftMethodSchema.optional(),
});

export const marketTargetSchema = marketTargetInputSchema.extend({
  id: z.uuid(),
  version: z.literal(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
});

export const marketImportListingSchema = z.strictObject({
  externalId: text(256).optional(),
  price: z
    .number()
    .finite()
    .positive()
    .max(1_000_000_000)
    .nullable()
    .default(null),
  currency: text(100).optional(),
  fee: z.number().finite().optional(),
  listedAt: z.iso.datetime().optional(),
  rawListing: z.record(z.string(), z.json()).optional(),
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
  provenance: z.enum(['manual_import', 'collection']),
  coverage: z.enum(['complete', 'partial', 'unknown']).optional(),
  inexact: z.boolean().optional(),
  queryDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
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
export type MarketImportListingInput = z.input<
  typeof marketImportListingSchema
>;
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

export const beltAnalysisSchema = z.strictObject({
  algorithm: z.enum([
    'belt-comparability-v1',
    'belt-comparability-v2',
    'belt-comparability-v3',
  ]),
  targetDigest: z.string(),
  snapshotId: z.uuid(),
  dataKind: z.enum(['observed', 'demo']),
  capturedAt: z.iso.datetime(),
  currency: z.enum(['chaos', 'divine']),
  status: z.literal('INSUFFICIENT_DATA'),
  reasons: z.array(z.string()),
  selectionBias: z.string(),
  independentSellers: z.number().int().nonnegative(),
  confirmedListings: z.number().int().nonnegative(),
  conservativeAskingPrice: z.number().positive().nullable(),
  rows: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      externalId: z.string().nullable(),
      price: z.number().positive(),
      seller: z.string().nullable(),
      status: z.enum(['MATCH', 'PARTIAL', 'REJECT']),
      reasons: z.array(z.string()),
    }),
  ),
});
export const beltAnalysisResponseSchema = z.strictObject({
  correlationId: z.uuid(),
  data: beltAnalysisSchema,
});
export type BeltAnalysis = z.infer<typeof beltAnalysisSchema>;

export const beltOpportunitySchema = z.strictObject({
  targetId: z.uuid(),
  targetDigest: z.string(),
  name: z.string(),
  league: z.string(),
  patch: z.string(),
  builds: z.array(z.string()),
  sources: z.array(marketSourceEvidenceSchema),
  rules: beltRulesSchema.nullable(),
  method: beltCraftMethodSchema.nullable(),
  snapshotId: z.uuid().nullable(),
  dataKind: z.enum(['observed', 'demo']).nullable(),
  capturedAt: z.iso.datetime().nullable(),
  sourceUrl: httpsUrl.nullable(),
  comparison: beltAnalysisSchema.nullable(),
  priceEvidence: z.array(z.json()),
  calculation: z
    .strictObject({
      expectedCraftCost: z.string(),
      askingPrice: z.string(),
      spread: z.string(),
      currency: z.string(),
      breakdown: z.json(),
    })
    .nullable(),
  status: z.enum(['RESEARCH', 'INSUFFICIENT_DATA', 'CALCULATED']),
  economicConclusion: z.enum(['POSITIVE', 'NON_POSITIVE']).nullable(),
  reasons: z.array(z.string()),
});
export const beltOpportunitiesResponseSchema = z.strictObject({
  correlationId: z.uuid(),
  data: z.array(beltOpportunitySchema),
});
export type BeltOpportunity = z.infer<typeof beltOpportunitySchema>;

/** Hard per-run limits. A source that exceeds them yields a partial or failed run, never a complete observation. */
export const marketCollectionBounds = {
  maxBatches: 100,
  maxRunListings: 1000,
  minIntervalMinutes: 5,
  maxIntervalMinutes: 1440,
} as const;

export const marketCollectionSettingsSchema = z.strictObject({
  targetId: z.uuid(),
  enabled: z.boolean(),
  paused: z.boolean(),
  intervalMinutes: z
    .number()
    .int()
    .min(marketCollectionBounds.minIntervalMinutes)
    .max(marketCollectionBounds.maxIntervalMinutes),
  nextRunAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export const marketCollectionSettingsInputSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    paused: z.boolean().optional(),
    intervalMinutes:
      marketCollectionSettingsSchema.shape.intervalMinutes.optional(),
  })
  .refine((input) => Object.keys(input).length > 0, 'Provide a setting');

/** blocked = no authorized source; rate_limited = source asked us to wait; empty/succeeded = complete observation. */
export const marketCollectionRunStatusSchema = z.enum([
  'running',
  'succeeded',
  'empty',
  'partial',
  'blocked',
  'rate_limited',
  'failed',
  'cancelled',
]);

export const marketCollectionListingSchema = marketImportListingSchema.extend({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export const marketCollectionSearchEvidenceSchema = z.strictObject({
  ids: z.array(text(256)).max(100_000),
  queryId: text(256).nullable(),
  reportedTotal: z.number().int().nonnegative().nullable(),
  request: z.record(z.string(), z.json()).optional(),
  raw: z.record(z.string(), z.json()).optional(),
});

export const marketCollectionRunSchema = z.strictObject({
  id: z.uuid(),
  targetId: z.uuid(),
  targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  league: text(100),
  patch: text(50),
  sourceId: text(100),
  queryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  dataKind: z.enum(['observed', 'demo']),
  trigger: z.enum(['manual', 'scheduled']),
  status: marketCollectionRunStatusSchema,
  publicationResult: z
    .strictObject({
      status: marketCollectionRunStatusSchema,
      errorCode: z.string().max(100).nullable(),
    })
    .optional(),
  coverage: z.enum(['complete', 'partial', 'unknown']).nullable(),
  reportedTotal: z.number().int().min(0).nullable(),
  returnedCount: z.number().int().min(0),
  fetchedCount: z.number().int().min(0),
  cached: z.boolean(),
  inexact: z.boolean().optional(),
  sourceUrl: httpsUrl.optional(),
  searchEvidence: marketCollectionSearchEvidenceSchema.optional(),
  currency: z.enum(['chaos', 'divine']).nullable(),
  listings: z
    .array(marketCollectionListingSchema)
    .max(marketCollectionBounds.maxRunListings),
  startedAt: z.iso.datetime(),
  capturedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  batchCount: z.number().int().min(0).max(marketCollectionBounds.maxBatches),
  listingCount: z
    .number()
    .int()
    .min(0)
    .max(marketCollectionBounds.maxRunListings),
  errorCode: z.string().max(100).nullable(),
  retryAt: z.iso.datetime().nullable(),
  snapshotId: z.uuid().nullable(),
  cancelRequested: z.boolean(),
});

export const marketCollectionSourceSchema = z.strictObject({
  id: text(100),
  name: text(),
  access: z.enum(['blocked', 'replay', 'authorized']),
  dataKind: z.enum(['observed', 'demo']),
  reason: z.string().max(1500).nullable(),
  implementation: z.enum(['manual', 'not_connected', 'replay']).optional(),
  authorization: z
    .enum(['user_supplied', 'unverified', 'test_only'])
    .optional(),
});

const idList = z.array(text(256)).max(50);
export const marketCollectionPointSchema = z.strictObject({
  snapshotId: z.uuid(),
  queryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  capturedAt: z.iso.datetime(),
  cached: z.boolean(),
  count: z.number().int().min(0),
  median: z.number().finite().positive().nullable(),
  untracked: z.number().int().min(0),
  newCount: z.number().int().min(0),
  persistedCount: z.number().int().min(0),
  missingCount: z.number().int().min(0),
  restoredCount: z.number().int().min(0),
  missing: idList,
  restored: idList,
  changedCount: z.number().int().min(0),
  changed: idList,
});

/** One series per data kind and currency, strictly within one target id, digest, league and patch. */
export const marketCollectionSeriesSchema = z.strictObject({
  dataKind: z.enum(['observed', 'demo']),
  currency: z.enum(['chaos', 'divine']),
  queryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  points: z.array(marketCollectionPointSchema),
});

export const marketCollectionResponseSchema = z.strictObject({
  correlationId: z.uuid(),
  data: z.strictObject({
    source: marketCollectionSourceSchema,
    settings: marketCollectionSettingsSchema.nullable(),
    runs: z.array(marketCollectionRunSchema).max(25),
    series: z.array(marketCollectionSeriesSchema),
    note: z.string(),
  }),
});

export const marketCollectionSettingsResponseSchema = z.strictObject({
  correlationId: z.uuid(),
  data: marketCollectionSettingsSchema,
});
export const marketCollectionRunResponseSchema = z.strictObject({
  correlationId: z.uuid(),
  data: marketCollectionRunSchema,
});

export type MarketCollectionSettings = z.infer<
  typeof marketCollectionSettingsSchema
>;
export type MarketCollectionSettingsInput = z.infer<
  typeof marketCollectionSettingsInputSchema
>;
export type MarketCollectionRun = z.infer<typeof marketCollectionRunSchema>;
export type MarketCollectionRunStatus = z.infer<
  typeof marketCollectionRunStatusSchema
>;
export type MarketCollectionSource = z.infer<
  typeof marketCollectionSourceSchema
>;
export type MarketCollectionSeries = z.infer<
  typeof marketCollectionSeriesSchema
>;
export type MarketCollectionPoint = z.infer<typeof marketCollectionPointSchema>;
export type MarketCollectionResponse = z.infer<
  typeof marketCollectionResponseSchema
>;
