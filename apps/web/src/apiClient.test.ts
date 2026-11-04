import { describe, expect, it, vi } from 'vitest';

import { ApiClientError, createApiClient } from './apiClient.js';
import { syntheticOutcomeInput } from '@poe-worksmith/domain/fixtures';

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
  it('keeps a missing outcome model explicit and isolates analysis by recipe and league', async () => {
    const payload = {
      correlationId,
      data: {
        recipeId: 'a/b',
        recipeHash: 'revision',
        targetSignature: 'target',
        league: 'Fixture / League',
        leagueId: '11111111-1111-4111-8111-111111111111',
        evaluatedAt: timestamp,
        modelRecord: null,
        embeddedModel: null,
        analysis: null,
        prices: {},
        valuations: {},
        unavailableReasons: ['Missing outcome probabilities'],
        canEdit: false,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(response(payload));
    await expect(
      createApiClient('', fetchMock).getCraftAnalysis(
        'a/b',
        'Fixture / League',
      ),
    ).resolves.toEqual(payload);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/recipes/a%2Fb/analysis?league=Fixture%20%2F%20League',
    );
  });

  it('preserves mutation idempotency, original values and provenance and surfaces owner-access rejection', async () => {
    const fixture = syntheticOutcomeInput();
    const payload = {
      recipeId: 'fixture',
      recipeHash: 'recipe-revision',
      league: fixture.league,
      currency: 'chaos' as const,
      expectedRevision: null,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      model: fixture.model,
      prices: fixture.prices,
      valuations: fixture.valuations,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        correlationId,
        error: {
          category: 'internal',
          code: 'OPERATOR_AUTH_REQUIRED',
          disposition: 'permanent',
          message: 'Operator authentication is required.',
          retryable: false,
        },
      }),
    );
    const client = createApiClient('', fetchMock);
    await expect(client.saveCraftModel(payload)).rejects.toBeInstanceOf(
      ApiClientError,
    );
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/admin/craft-analysis/models',
    );
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual(payload);
    await expect(
      client.cancelCraftRisk('a/b', payload.idempotencyKey),
    ).rejects.toBeInstanceOf(ApiClientError);
    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/admin/craft-analysis/simulations/a%2Fb/cancel',
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ idempotencyKey: payload.idempotencyKey }),
      },
    ]);
  });
});
