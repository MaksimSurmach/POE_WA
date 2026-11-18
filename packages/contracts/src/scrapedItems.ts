import {
  scrapedItemRoleSchema,
  scrapedItemSpecSchema,
} from '@poe-worksmith/domain';
import { z } from 'zod';

const correlationId = z.uuid();
const revision = z.number().int().min(1);

export const scrapedItemDiagnosticSchema = z.strictObject({
  code: z.string().min(1),
  entityId: z.string().optional(),
  message: z.string().min(1),
  path: z.string().optional(),
});
export type ScrapedItemDiagnostic = z.infer<typeof scrapedItemDiagnosticSchema>;

/** What the provider reported and what the collector actually stored. */
export const scrapedCaptureFactsSchema = z.strictObject({
  captureId: z.uuid(),
  capturedAt: z.iso.datetime(),
  coverage: z.enum(['complete', 'partial']),
  durationMs: z.number().int().nonnegative(),
  fetched: z.number().int().nonnegative(),
  partialReason: z.string().nullable(),
  queryVersion: z.string().nullable(),
  reportedTotal: z.number().int().nonnegative(),
  slices: z.number().int().nonnegative(),
});

/** Whether stored listings satisfy the search; separate from collection quality. */
export const scrapedCaptureDiagnosticsSchema = scrapedCaptureFactsSchema.extend(
  {
    listings: z
      .strictObject({
        stored: z.number().int().nonnegative(),
        priced: z.number().int().nonnegative(),
        completeItems: z.number().int().nonnegative(),
        analyzed: z.number().int().nonnegative(),
        excluded: z.number().int().nonnegative(),
        unreadable: z.number().int().nonnegative(),
        matched: z.number().int().nonnegative(),
        comparable: z.number().int().nonnegative(),
        rejected: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
      })
      .nullable(),
    listingsUnavailable: z
      .enum(['superseded-by-later-capture', 'query-unavailable'])
      .nullable(),
    reasons: z.array(
      z.strictObject({
        count: z.number().int().positive(),
        reason: z.string(),
        status: z.enum(['rejected', 'unknown']),
      }),
    ),
  },
);
export type ScrapedCaptureFacts = z.infer<typeof scrapedCaptureFactsSchema>;
export type ScrapedCaptureDiagnostics = z.infer<
  typeof scrapedCaptureDiagnosticsSchema
>;

/**
 * Where a descriptive name came from. Canonical metadata can be sparse, so a
 * name is never invented from an id: it is either sourced or reported missing.
 */
export const scrapedNameSourceSchema = z.enum([
  'canonical',
  'presentation',
  'trade',
  'unavailable',
]);
export type ScrapedNameSource = z.infer<typeof scrapedNameSourceSchema>;

export const scrapedItemSchema = z.strictObject({
  baseId: z.string().min(1),
  baseName: z.string().nullable(),
  baseNameSource: scrapedNameSourceSchema,
  id: z.uuid(),
  recentListings: z
    .strictObject({
      count: z.number().int().nonnegative(),
      from: z.iso.datetime(),
      to: z.iso.datetime(),
    })
    .nullable()
    .optional(),
  latestCapture: scrapedCaptureFactsSchema.nullable(),
  modifiers: z.array(
    z.strictObject({
      name: z.string().nullable(),
      nameSource: scrapedNameSourceSchema,
      tradeMapped: z.boolean(),
      // The provider's own wording for the mapped stat, when one is known.
      tradeText: z.string().nullable(),
    }),
  ),
  origin: z.enum(['recipe', 'owner']),
  query: z.strictObject({
    diagnostics: z.array(scrapedItemDiagnosticSchema),
    key: z.string().nullable(),
    status: z.enum(['ready', 'blocked']),
    tradeUrl: z.string().nullable(),
  }),
  recipes: z.array(
    z.strictObject({
      // The recipe's own requirement differs from what this item scrapes.
      definitionChanged: z.boolean(),
      id: z.string().min(1),
      title: z.string().min(1),
    }),
  ),
  revision,
  role: scrapedItemRoleSchema,
  schedule: z
    .strictObject({
      enabled: z.boolean(),
      intervalMinutes: z.number().int().positive(),
      lastError: z.string().nullable(),
      lastFinishedAt: z.iso.datetime().nullable(),
      lastStatus: z.string().nullable(),
      nextDueAt: z.iso.datetime(),
    })
    .nullable(),
  /** Other items and recipes that this exact search also serves. */
  sharedQuery: z.strictObject({
    itemIds: z.array(z.uuid()),
    recipes: z.array(
      z.strictObject({
        id: z.string().min(1),
        role: scrapedItemRoleSchema,
        title: z.string().min(1),
      }),
    ),
  }),
  spec: scrapedItemSpecSchema,
  updatedAt: z.iso.datetime(),
});
export type ScrapedItem = z.infer<typeof scrapedItemSchema>;

export const scrapedItemsResponseSchema = z.strictObject({
  correlationId,
  data: z.strictObject({
    collectionsPaused: z.boolean(),
    generatedAt: z.iso.datetime(),
    items: z.array(scrapedItemSchema),
    league: z
      .strictObject({
        gggId: z.string().min(1),
        id: z.uuid(),
        name: z.string(),
      })
      .nullable(),
    recipes: z.array(
      z.strictObject({
        base: z.uuid().nullable(),
        id: z.string().min(1),
        output: z.uuid().nullable(),
        title: z.string().min(1),
      }),
    ),
  }),
});
export type ScrapedItemsResponse = z.infer<typeof scrapedItemsResponseSchema>;

export const scrapedItemSaveInputSchema = z.strictObject({
  expectedRevision: revision,
  spec: scrapedItemSpecSchema,
});
export const scrapedItemLinkInputSchema = z.strictObject({
  expectedRevision: revision,
  recipeId: z.string().min(1).max(200),
});
export const scrapedItemRevisionInputSchema = z.strictObject({
  expectedRevision: revision,
});
export type ScrapedItemSaveInput = z.infer<typeof scrapedItemSaveInputSchema>;
export type ScrapedItemLinkInput = z.infer<typeof scrapedItemLinkInputSchema>;

export const scrapedItemWriteResponseSchema = z.strictObject({
  correlationId,
  data: z.strictObject({
    item: scrapedItemSchema,
    // Deferred means the edit is saved and the collector will apply it on its next sync.
    schedule: z.enum(['synchronized', 'deferred']),
  }),
});
export type ScrapedItemWriteResponse = z.infer<
  typeof scrapedItemWriteResponseSchema
>;

/** HTTP 422: the request was understood but cannot be saved or run. */
export const scrapedItemRejectionSchema = z.strictObject({
  correlationId,
  data: z.strictObject({
    diagnostics: z.array(scrapedItemDiagnosticSchema).min(1),
    status: z.literal('rejected'),
  }),
});
export type ScrapedItemRejection = z.infer<typeof scrapedItemRejectionSchema>;

export const scrapedItemModifiersResponseSchema = z.strictObject({
  correlationId,
  data: z.strictObject({
    modifiers: z.array(
      z.strictObject({
        // Null where the canonical entity has no such metadata.
        familyId: z.string().nullable(),
        generationType: z.string().nullable(),
        id: z.string().min(1),
        name: z.string().nullable(),
        nameSource: scrapedNameSourceSchema,
        requiredLevel: z.number().int().nonnegative().nullable(),
        tradeMapped: z.boolean(),
        tradeText: z.string().nullable(),
      }),
    ),
  }),
});
export type ScrapedItemModifiersResponse = z.infer<
  typeof scrapedItemModifiersResponseSchema
>;

export const scrapedItemBasesResponseSchema = z.strictObject({
  correlationId,
  data: z.strictObject({
    bases: z.array(
      z.strictObject({
        id: z.string().min(1),
        name: z.string().min(1),
        itemClass: z.string().nullable(),
      }),
    ),
  }),
});
export type ScrapedItemBasesResponse = z.infer<
  typeof scrapedItemBasesResponseSchema
>;

export const scrapedItemTestStartResponseSchema = z.strictObject({
  correlationId,
  data: z.strictObject({
    itemId: z.uuid(),
    itemRevision: revision,
    // The id of this item's own run request, not a shared recipe or full-catalog run.
    requestId: z.uuid(),
    scheduleKey: z.string().min(1),
  }),
});
export type ScrapedItemTestStartResponse = z.infer<
  typeof scrapedItemTestStartResponseSchema
>;

export const scrapedItemTestStateSchema = z.enum([
  'queued',
  'running',
  'blocked',
  'failed',
  'succeeded',
]);
export const scrapedItemTestSchema = z.strictObject({
  capture: scrapedCaptureDiagnosticsSchema.nullable(),
  currentRevision: revision,
  // The search the item compiles to now; null when it cannot be compiled.
  currentScheduleKey: z.string().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  itemId: z.uuid(),
  itemRevision: revision,
  reason: z.string().nullable(),
  requestId: z.uuid(),
  requestedAt: z.iso.datetime(),
  scheduleKey: z.string(),
  // The item was edited, or its search changed, after this test was submitted;
  // its result is history, not current.
  stale: z.boolean(),
  startedAt: z.iso.datetime().nullable(),
  state: scrapedItemTestStateSchema,
});
export type ScrapedItemTest = z.infer<typeof scrapedItemTestSchema>;
export const scrapedItemTestResponseSchema = z.strictObject({
  correlationId,
  data: scrapedItemTestSchema,
});
export type ScrapedItemTestResponse = z.infer<
  typeof scrapedItemTestResponseSchema
>;

export const scrapedItemCaptureResponseSchema = z.strictObject({
  correlationId,
  data: scrapedCaptureDiagnosticsSchema.nullable(),
});
