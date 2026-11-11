import { describe, expect, it } from 'vitest';
import {
  apiErrorEnvelopeSchema,
  catalogResponseSchema,
  collectorStatusSchema,
  currentLeagueResponseSchema,
  factoryBatchListResponseSchema,
  factoryBatchResponseSchema,
  factorySummaryResponseSchema,
  recipeResponseSchema,
  recipeTrendResponseSchema,
  trendOverviewResponseSchema,
} from '@poe-worksmith/contracts';
import { createPreviewFetch } from './previewApi.js';

const id = '00000000-0000-4000-8000-000000000010';

describe('standalone preview data', () => {
  it('uses valid shared contracts for each preview screen', async () => {
    const fetch = createPreviewFetch();
    for (const [path, schema] of [
      ['/api/catalog', catalogResponseSchema],
      ['/api/leagues/current', currentLeagueResponseSchema],
      ['/api/collector/status', collectorStatusSchema],
      ['/api/recipes/profitable-cluster', recipeResponseSchema],
      ['/api/trends?range=7d', trendOverviewResponseSchema],
      ['/api/trends/profitable-cluster?range=7d', recipeTrendResponseSchema],
      ['/api/admin/factory/batches', factoryBatchListResponseSchema],
      [`/api/admin/factory/batches/${id}`, factoryBatchResponseSchema],
      ['/api/admin/factory/summary', factorySummaryResponseSchema],
    ] as const) {
      const response = await fetch(path);
      expect(response.ok, path).toBe(true);
      expect(schema.safeParse(await response.json()).success, path).toBe(true);
    }
  });
  it('derives illustrative ledger metrics with the production accounting model', async () => {
    const response = await createPreviewFetch()('/api/admin/factory/summary');
    const { data } = factorySummaryResponseSchema.parse(await response.json());
    expect(data.metrics.realizedProfit).toBe('60');
    expect(data.metrics.cashFlow).toBe('-40');
    expect(data.metrics.unusedMaterialCost).toBe('100');
  });
  it('blocks every mutation and unknown destination without delegating to network fetch', async () => {
    const fetch = createPreviewFetch();
    for (const [path, method] of [
      ['/api/run', 'POST'],
      ['/api/admin/market/pause', 'POST'],
      ['/api/admin/market/settings', 'PATCH'],
      ['https://example.com/private', 'GET'],
    ] as const) {
      const response = await fetch(path, { method });
      expect(response.status).toBe(403);
      expect(
        apiErrorEnvelopeSchema.safeParse(await response.json()).success,
      ).toBe(true);
    }
  });
});
