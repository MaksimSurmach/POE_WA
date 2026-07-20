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
});
