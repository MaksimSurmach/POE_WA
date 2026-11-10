import { expect, it, vi } from 'vitest';
import { createCollectorEconomyCache } from './collectorResults.js';
import type { StoredMarketEconomySnapshot } from './marketEconomy.js';
import { recipeResultSchema } from './recipeResult.js';

it('reuses immutable economy payloads by ID without caching a miss', async () => {
  const snapshot: StoredMarketEconomySnapshot = {
    id: '978d82d2-8466-4537-b1fb-2c187b6301d0',
    schemaVersion: 1,
    source: 'poe.ninja',
    game: 'poe1',
    kind: 'economy-overview',
    league: 'Standard',
    category: 'Currency',
    endpoint: 'https://poe.ninja',
    payloadHash: 'a'.repeat(64),
    capturedAt: '2026-07-20T00:00:00.000Z',
    sourceUpdatedAt: null,
    priceBasis: 'currency-exchange',
    raw: { ignored: true },
    lines: [],
  };
  const find = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(snapshot);
  const read = createCollectorEconomyCache();
  expect(await read({ find }, snapshot.id)).toBeNull();
  const evidence = { ...snapshot, raw: {} };
  expect(await read({ find }, snapshot.id)).toEqual(evidence);
  expect(await read({ find }, snapshot.id)).toEqual(evidence);
  expect(find).toHaveBeenCalledTimes(2);
});

it('accepts finite decimal amounts in the estimator’s exponent format', () => {
  const { estimatedSalePrice } = recipeResultSchema.shape;
  expect(estimatedSalePrice.parse('1e-8')).toBe('1e-8');
  expect(estimatedSalePrice.safeParse('1e999').success).toBe(false);
});
