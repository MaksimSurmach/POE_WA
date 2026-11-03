import { describe, expect, it } from 'vitest';
import { createInMemoryRepositories } from '@poe-worksmith/domain';
import { createMarketTarget } from './marketResearch.js';
import {
  createBatchedMarketCollectionSource,
  isCompleteSortedPriceSample,
} from './marketCollection.js';
import { GggRateLimitController } from './rateLimitController.js';

describe('bounded handbook asking-price sample', () => {
  it.each([
    'complete',
    'missing',
    'wrong-id',
    'cancelled',
    'unsorted',
    'broad-query',
    'inexact',
  ] as const)(
    'preserves full search evidence and proves only the exact first 20: %s',
    async (mode) => {
      const ids = Array.from({ length: 100 }, (_, index) => `id-${index}`);
      const requested: string[][] = [];
      const controller = new AbortController();
      let clockMs = Date.parse('2026-11-03T00:00:00Z');
      const target = createMarketTarget({
        name: 'handbook fixture',
        game: 'poe1',
        realm: 'pc',
        league: 'Fixture',
        patch: '3.29',
        slot: 'crafted-item',
        baseTypes: ['Large Cluster Jewel'],
        builds: [],
        requiredMods: [],
        sources: [],
        tradeSearch: {
          version: 1,
          scope: 'strict',
          status: 'securable',
          currency: 'chaos',
          rarity: 'rare',
          groups: [],
        },
      });
      const source = createBatchedMarketCollectionSource({
        descriptor: {
          id: 'fixture',
          name: 'fixture',
          access: 'authorized',
          dataKind: 'observed',
          reason: null,
        },
        rateLimits: new GggRateLimitController({
          repository: createInMemoryRepositories().rateLimits,
          sleep: async (milliseconds) => {
            clockMs += milliseconds;
          },
          clock: () => new Date(clockMs),
        }),
        transport: {
          async search() {
            return {
              cached: false,
              status: 200,
              headers: new Headers(),
              data: {
                ids,
                queryId: 'sample',
                reportedTotal: 340,
                capturedAt: '2026-11-03T00:00:00Z',
                coverage: 'partial',
                currency: 'chaos',
                inexact: mode === 'inexact',
                request: {
                  scope: mode === 'broad-query' ? 'broad' : 'strict',
                  sort:
                    mode === 'unsorted'
                      ? { indexed: 'desc' }
                      : { price: 'asc' },
                },
                raw: { result: ids, total: 340 },
              },
            };
          },
          async fetchDetails({ ids: page }) {
            requested.push(page);
            if (mode === 'cancelled' && requested.length === 2) {
              controller.abort();
              throw controller.signal.reason;
            }
            return {
              cached: false,
              status: 200,
              headers: new Headers(),
              data: page.map((id, index) =>
                mode === 'missing' && index === 0
                  ? null
                  : {
                      externalId:
                        mode === 'wrong-id' && index === 0
                          ? 'not-requested'
                          : id,
                      price: index + 10,
                      item: { name: id },
                    },
              ),
            };
          },
        },
      });
      const result = await source.collect({
        target,
        signal: controller.signal,
      });
      expect(requested.flat()).toEqual(
        ids.slice(0, mode === 'wrong-id' ? 10 : 20),
      );
      expect(result.searchEvidence).toMatchObject({
        ids,
        raw: { result: ids, total: 340 },
      });
      expect(result.coverage).toBe('partial');
      expect(result.sortedSampleComplete).toBe(mode === 'complete');
      expect(isCompleteSortedPriceSample(result, target)).toBe(
        mode === 'complete',
      );
      if (mode === 'complete') {
        expect(result.listings.map((row) => row.externalId)).toEqual(
          ids.slice(0, 20),
        );
        expect(
          isCompleteSortedPriceSample(
            {
              ...result,
              listings: result.listings.map((row, index) =>
                index === 0 ? { ...row, externalId: ids[20] } : row,
              ),
            },
            target,
          ),
        ).toBe(false);
      }
    },
  );
});
