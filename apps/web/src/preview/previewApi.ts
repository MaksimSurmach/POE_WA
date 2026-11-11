import type {
  MarketAdminSettingsResponse,
  TrendRange,
} from '@poe-worksmith/contracts';
import { factoryBatchSchema, projectFactoryBatch } from '@poe-worksmith/domain';
import { buildFactoryEvent } from '../factoryForm.js';
import { catalogFixtures } from '../mocks/catalog.js';
import { recipeDetails } from '../mocks/recipeDetails.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-11-11T12:00:00.000Z';
const league = { id: id(1), name: 'Preview League' };
const fullLeague = {
  ...league,
  game: 'poe1',
  realm: 'pc',
  gggId: league.name,
  startAt: null,
  endAt: null,
  isCurrent: true,
  discovery: 'confirmed',
  syncedAt: at,
  createdAt: at,
  updatedAt: at,
};
const envelope = (data: unknown) => ({
  correlationId: id(1),
  data,
  errorCode: null,
  isStale: false,
  lastSuccessfulAt: at,
  publishedAt: at,
  refreshStatus: 'published',
  state: 'success',
});
const unavailable = () =>
  Response.json(
    {
      correlationId: id(1),
      error: {
        category: 'persistence',
        code: 'PERSISTENCE_NOT_FOUND',
        disposition: 'permanent',
        message: 'The requested record does not exist.',
        retryable: false,
      },
    },
    { status: 403 },
  );
const configured: MarketAdminSettingsResponse['configured'] = {
  automaticRefreshEnabled: true,
  scheduledCollectionEnabled: true,
  collectionsPaused: false,
  manualRefreshEnabled: true,
  refreshCron: '0 * * * *',
  requestTimeoutMs: 10_000,
  collectionConcurrency: 1,
  snapshotReuseTtlMs: 600_000,
  freshnessWarningMs: 3_600_000,
  maximumQuoteAgeMs: 7_200_000,
  rawRetentionHours: 168,
  historyRetentionDays: 90,
};
const settings: MarketAdminSettingsResponse = {
  version: 1,
  configured,
  effective: { ...configured },
  restartRequired: false,
  applies: 'Read-only preview',
  timezone: 'UTC',
  warnings: ['Sample data. Live actions are disabled.'],
};

const batch = factoryBatchSchema.parse({
  id: id(10),
  recipeId: catalogFixtures[0]!.recipe.id,
  recipeHash: 'preview-revision',
  targetSignature: 'preview-target',
  leagueId: league.id,
  league: league.name,
  accountingCurrency: 'chaos',
  startedAt: '2026-11-11T08:00:00.000Z',
  plannedBudget: {
    quantity: '1',
    unitPrice: '500',
    currency: 'chaos',
    chaosPerUnit: '1',
    rateSource: 'Illustrative preview budget',
  },
  notes: 'Illustrative batch. These are not real purchases or sales.',
  forecast: null,
});
function event(n: number, hour: number, fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    source: 'Static design preview · synthetic transaction',
    ...fields,
  }))
    form.set(key, value);
  return buildFactoryEvent(
    form,
    id(n),
    `2026-11-11T${String(hour).padStart(2, '0')}:00:00.000Z`,
  );
}
const transaction = {
  quantity: '2',
  unitPrice: '100',
  currency: 'chaos',
  chaosPerUnit: '1',
  rateSource: 'Illustrative chaos transaction',
};
const events = [
  event(20, 8, {
    type: 'purchase',
    resourceId: 'Crafting materials',
    ...transaction,
  }),
  event(21, 9, {
    type: 'consume',
    purchaseEventId: id(20),
    stockQuantity: '1',
  }),
  event(22, 9, {
    type: 'produce',
    description: 'Illustrative finished item',
    classification: 'salvage',
    outcome: 'preview-salvage',
    allocationCost: id(21),
    allocationAmount: '100',
  }),
  event(23, 11, {
    type: 'sale',
    itemId: id(22),
    ...transaction,
    quantity: '1',
    unitPrice: '160',
  }),
];
const projection = projectFactoryBatch(batch, events, at);
const record = { batch, events, projection, version: events.length };
const coverage = { complete: true, includedBatches: 1, totalBatches: 1 };

function trendWindow(range: TrendRange) {
  const days = { '24h': 1, '7d': 7, '30d': 30, '1y': 365 }[range];
  return {
    state: 'available',
    range,
    bucketSeconds: days === 1 ? 3600 : 86400,
    windowStart: new Date(Date.parse(at) - days * 86_400_000).toISOString(),
    windowEnd: at,
    league,
    priceBasis: 'asking',
    salesVolume: 'unknown',
  } as const;
}
function summary(entry: (typeof catalogFixtures)[number], range: TrendRange) {
  const ask = entry.evaluation.estimatedSalePrice;
  if (!ask) return null;
  const window = trendWindow(range);
  return {
    currency: ask.currency,
    latestAsk: ask.amount,
    latestObservedAt: at,
    latestComparableSellers: 4,
    latestCoverage: 'complete',
    latestCraftCost: entry.evaluation.expectedCraftCost?.amount ?? null,
    latestCraftCostObservedAt: entry.evaluation.expectedCraftCost ? at : null,
    windowObservations: 8,
    windowFirstObservedAt: window.windowStart,
    windowLastObservedAt: at,
    change: {
      from: ask.amount * 0.9,
      to: ask.amount,
      fromObservedAt: window.windowStart,
      toObservedAt: at,
      absolute: ask.amount * 0.1,
      percent: 11.1,
    },
    excludedCurrencies: [],
  };
}

/** All requests stay in memory; unknown routes and every write fail closed. */
export function createPreviewFetch(): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(
      request?.url ?? String(input),
      'https://preview.invalid',
    );
    if ((init?.method ?? request?.method ?? 'GET').toUpperCase() !== 'GET')
      return unavailable();
    const path = url.pathname;
    let data: unknown;
    const range = (
      ['24h', '7d', '30d', '1y'].includes(url.searchParams.get('range') ?? '')
        ? url.searchParams.get('range')
        : '7d'
    ) as TrendRange;
    if (path === '/api/catalog')
      data = envelope({
        entries: catalogFixtures,
        league,
        pipeline: 'collector',
      });
    else if (path === '/api/leagues/current')
      data = { correlationId: id(1), data: fullLeague };
    else if (path === '/api/leagues')
      data = { correlationId: id(1), data: [fullLeague] };
    else if (path === '/api/collector/status')
      data = {
        collectorState: {
          lastRunFinishedAt: at,
          lastRunStatus: 'succeeded',
          blockedReason: null,
          sessionCheckedAt: at,
        },
        latestRequest: null,
        lockHeld: true,
        nextDueAt: '2026-11-11T13:00:00.000Z',
      };
    else if (path === '/api/collector/readiness')
      data = { evaluatedAt: at, targets: [] };
    else if (path === '/api/admin/market/settings') data = { data: settings };
    else if (path === '/api/crafting-prices')
      data = {
        correlationId: id(1),
        data: { league: null, checkedAt: at, quotes: [] },
      };
    else if (path === '/api/trends')
      data = {
        correlationId: id(1),
        data: {
          ...trendWindow(range),
          entries: catalogFixtures.map((entry) => ({
            recipeId: entry.recipe.id,
            title: entry.recipe.title,
            category: entry.recipe.category,
            summary: summary(entry, range),
          })),
        },
      };
    else if (path.startsWith('/api/trends/')) {
      const entry = catalogFixtures.find(
        (entry) =>
          entry.recipe.id ===
          decodeURIComponent(path.slice('/api/trends/'.length)),
      );
      if (!entry) return unavailable();
      const window = trendWindow(range);
      const quote = summary(entry, range);
      const curve = [0.9, 0.93, 0.92, 0.97, 0.96, 1.02, 0.98, 1];
      data = {
        correlationId: id(1),
        data: {
          ...window,
          recipeId: entry.recipe.id,
          title: entry.recipe.title,
          summary: quote,
          buckets: quote
            ? curve.map((factor, index) => {
                const time = new Date(
                  Date.parse(window.windowStart) +
                    (index *
                      (Date.parse(at) - Date.parse(window.windowStart))) /
                      7,
                ).toISOString();
                const value = quote.latestAsk * factor;
                return {
                  start: time,
                  firstObservedAt: time,
                  lastObservedAt: time,
                  open: value,
                  close: value,
                  high: value * 1.02,
                  low: value * 0.98,
                  observations: 1,
                  craftCost: null,
                  craftCostObservedAt: null,
                  minComparableSellers: 4,
                  lastComparableSellers: 4,
                };
              })
            : [],
        },
      };
    } else if (path.startsWith('/api/recipes/')) {
      const detail = recipeDetails.find(
        (detail) => `/api/recipes/${detail.recipe.id}` === path,
      );
      if (!detail) return unavailable();
      data = envelope(detail);
    } else if (path === '/api/admin/factory/summary')
      data = {
        correlationId: id(1),
        data: {
          accountingCurrency: 'chaos',
          metrics: projection.metrics,
          coverage,
          asOf: at,
        },
      };
    else if (path === '/api/admin/factory/batches')
      data = {
        correlationId: id(1),
        data: {
          batches: [{ batch, projection, version: record.version }],
          total: 1,
          offset: 0,
          limit: 20,
        },
      };
    else if (path === `/api/admin/factory/batches/${batch.id}`)
      data = { correlationId: id(1), data: record };
    else return unavailable();
    return Response.json(data);
  };
}
