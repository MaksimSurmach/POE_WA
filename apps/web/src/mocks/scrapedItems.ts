import type {
  ScrapedItem,
  ScrapedCaptureDiagnostics,
} from '@poe-worksmith/contracts';

/** Test-only data; nothing here is ever rendered outside tests. */
export const fixtureItem: ScrapedItem = {
  baseId: 'Metadata/Items/Jewels/JewelPassiveTreeExpansionLarge',
  baseName: 'Large Cluster Jewel',
  baseNameSource: 'canonical',
  id: '11111111-1111-4111-8111-111111111111',
  latestCapture: {
    captureId: '22222222-2222-4222-8222-222222222222',
    capturedAt: '2026-11-18T10:00:00.000Z',
    coverage: 'complete',
    durationMs: 420,
    fetched: 12,
    partialReason: null,
    queryVersion: 'abc',
    reportedTotal: 12,
    slices: 1,
  },
  modifiers: [
    {
      name: 'Battle-Hardened',
      nameSource: 'canonical',
      tradeMapped: true,
      tradeText: null,
    },
    {
      name: null,
      nameSource: 'unavailable',
      tradeMapped: false,
      tradeText: null,
    },
  ],
  origin: 'owner',
  query: {
    diagnostics: [],
    key: 'abc',
    status: 'ready',
    tradeUrl: 'https://www.pathofexile.com/trade/search/Fixture?q=%7B%7D',
  },
  recipes: [
    { definitionChanged: false, id: 'recipe-a', title: 'Recipe A' },
    { definitionChanged: true, id: 'recipe-b', title: 'Recipe B' },
  ],
  revision: 3,
  role: 'output',
  schedule: {
    enabled: true,
    intervalMinutes: 60,
    lastError: null,
    lastFinishedAt: '2026-11-18T10:00:05.000Z',
    lastStatus: 'succeeded',
    nextDueAt: '2026-11-18T11:00:00.000Z',
  },
  sharedQuery: {
    itemIds: ['33333333-3333-4333-8333-333333333333'],
    recipes: [{ id: 'recipe-c', role: 'output', title: 'Recipe C' }],
  },
  spec: {
    conditions: [
      {
        kind: 'explicit',
        modId: 'mod:battle-hardened',
        excluded: false,
        minimumValue: 5,
      },
      { kind: 'explicit', modId: 'mod:unmapped', excluded: false },
    ],
    gameDataVersion: '3.29.3.3',
    item: {
      baseId: 'Metadata/Items/Jewels/JewelPassiveTreeExpansionLarge',
      influences: [],
      itemLevel: 83,
      rarity: 'rare',
      state: { corrupted: false, fractured: false, synthesised: false },
      variant: { kind: 'none' },
    },
    patch: '3.29.3.3',
  },
  updatedAt: '2026-11-18T09:00:00.000Z',
};

export const fixtureCapture: ScrapedCaptureDiagnostics = {
  captureId: '22222222-2222-4222-8222-222222222222',
  capturedAt: '2026-11-18T10:00:00.000Z',
  coverage: 'complete',
  durationMs: 420,
  fetched: 12,
  partialReason: null,
  queryVersion: 'abc',
  reportedTotal: 12,
  slices: 1,
  listings: {
    stored: 12,
    priced: 12,
    completeItems: 11,
    analyzed: 12,
    excluded: 0,
    unreadable: 0,
    matched: 0,
    comparable: 0,
    rejected: 9,
    unknown: 3,
  },
  listingsUnavailable: null,
  reasons: [
    { count: 9, reason: 'base: mismatch', status: 'rejected' },
    { count: 3, reason: 'mod:x: missing or ambiguous', status: 'unknown' },
  ],
};
