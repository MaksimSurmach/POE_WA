import { describe, expect, it, vi } from 'vitest';

import { ApiClientError, createApiClient } from './apiClient.js';

const correlationId = '33333333-3333-4333-8333-333333333333';
const timestamp = '2026-07-20T00:00:00.000Z';

function response(payload: unknown) {
  return { json: async () => payload } as Response;
}

describe('typed API client', () => {
  it('parses catalog states through the shared contract', async () => {
    const payload = {
      correlationId,
      data: { entries: [] },
      errorCode: null,
      isStale: false,
      lastSuccessfulAt: timestamp,
      publishedAt: timestamp,
      refreshStatus: 'published',
      state: 'success',
    };
    const fetchMock = vi.fn().mockResolvedValue(response(payload));
    const client = createApiClient('https://example.test/', fetchMock);

    await expect(client.getCatalog()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/api/catalog', {
      headers: { accept: 'application/json' },
    });
  });

  it('throws typed unified API errors and encodes recipe IDs', async () => {
    const payload = {
      correlationId,
      error: {
        category: 'persistence',
        code: 'PERSISTENCE_NOT_FOUND',
        disposition: 'permanent',
        message: 'The requested record does not exist.',
        retryable: false,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(response(payload));
    const client = createApiClient('', fetchMock);

    try {
      await client.getRecipe('missing/recipe');
      expect.unreachable('Expected API client to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiClientError);
      expect((error as ApiClientError).envelope).toEqual(payload);
    }
    expect(fetchMock).toHaveBeenCalledWith('/api/recipes/missing%2Frecipe', {
      headers: { accept: 'application/json' },
    });
  });

  it('posts a manual price refresh through the shared contract', async () => {
    const payload = { correlationId, data: { accepted: true } };
    const fetchMock = vi.fn().mockResolvedValue(response(payload));
    const client = createApiClient('', fetchMock);

    await expect(client.triggerPriceRefresh()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/refresh', {
      headers: { accept: 'application/json' },
      method: 'POST',
    });
  });

  it('requests bounded trend ranges and encodes recipe IDs', async () => {
    const data = {
      state: 'empty',
      range: '30d',
      bucketSeconds: 86400,
      windowStart: timestamp,
      windowEnd: timestamp,
      league: { id: 'league', name: 'League' },
      priceBasis: 'asking',
      salesVolume: 'unknown',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({ correlationId, data: { ...data, entries: [] } }),
      )
      .mockResolvedValueOnce(
        response({
          correlationId,
          data: {
            ...data,
            recipeId: 'a/b',
            title: 'A',
            summary: null,
            buckets: [],
          },
        }),
      );
    const client = createApiClient('', fetchMock);

    await expect(client.getTrendOverview('30d')).resolves.toMatchObject({
      data: { state: 'empty' },
    });
    await expect(client.getRecipeTrend('a/b', '30d')).resolves.toMatchObject({
      data: { recipeId: 'a/b' },
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/trends?range=30d',
      '/api/trends/a%2Fb?range=30d',
    ]);
  });
});
