import { apiErrorEnvelopeSchema } from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { buildApi } from './api.js';

describe('health API', () => {
  it('reports liveness without external dependencies', async () => {
    const api = buildApi(pino({ level: 'silent' }), vi.fn(), async () => ({
      active: null,
      published: null,
    }));

    const response = await api.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      correlationId: response.headers['x-request-id'],
      status: 'ok',
    });
    await api.close();
  });

  it('reports database readiness and failure', async () => {
    const readProgress = async () => ({ active: null, published: null });
    const readyApi = buildApi(pino({ level: 'silent' }), vi.fn(), readProgress);
    const unavailableApi = buildApi(
      pino({ level: 'silent' }),
      async () => {
        throw new Error('unavailable');
      },
      readProgress,
    );

    const ready = await readyApi.inject({
      method: 'GET',
      url: '/health/ready',
    });
    const unavailable = await unavailableApi.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      correlationId: ready.headers['x-request-id'],
      status: 'ready',
    });
    expect(unavailable.statusCode).toBe(503);
    expect(apiErrorEnvelopeSchema.parse(unavailable.json())).toMatchObject({
      correlationId: unavailable.headers['x-request-id'],
      error: { code: 'PERSISTENCE_UNAVAILABLE' },
    });
    await Promise.all([readyApi.close(), unavailableApi.close()]);
  });

  it('propagates valid request IDs and normalizes all route errors', async () => {
    const api = buildApi(pino({ level: 'silent' }), vi.fn(), async () => ({
      active: null,
      published: null,
    }));
    api.get('/domain-error', async () => {
      throw new DomainError('MARKET_QUERY_INVALID');
    });
    api.get('/unknown-error', async () => {
      throw new Error('token=super-secret');
    });
    const correlationId = '22222222-2222-4222-8222-222222222222';

    const domain = await api.inject({
      headers: { 'x-request-id': correlationId },
      method: 'GET',
      url: '/domain-error',
    });
    const unknown = await api.inject({
      headers: { 'x-request-id': 'not-a-uuid' },
      method: 'GET',
      url: '/unknown-error',
    });
    const notFound = await api.inject({ method: 'GET', url: '/missing' });

    expect(domain.statusCode).toBe(400);
    expect(apiErrorEnvelopeSchema.parse(domain.json())).toMatchObject({
      correlationId,
      error: { code: 'MARKET_QUERY_INVALID' },
    });
    const unknownEnvelope = apiErrorEnvelopeSchema.parse(unknown.json());
    expect(unknown.statusCode).toBe(500);
    expect(unknownEnvelope.correlationId).toBe(unknown.headers['x-request-id']);
    expect(unknownEnvelope.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(unknownEnvelope)).not.toContain('super-secret');
    expect(notFound.statusCode).toBe(404);
    expect(apiErrorEnvelopeSchema.parse(notFound.json())).toMatchObject({
      correlationId: notFound.headers['x-request-id'],
      error: { code: 'ROUTE_NOT_FOUND' },
    });
    await api.close();
  });

  it('returns current and published refresh progress with every counter', async () => {
    const timestamp = new Date('2026-07-20T00:00:00.000Z');
    const api = buildApi(pino({ level: 'silent' }), vi.fn(), async () => ({
      active: {
        completedQueries: 7,
        completedRecipes: 2,
        errorMessage: null,
        failedQueries: 1,
        failedRecipes: 0,
        finishedAt: null,
        id: 'cycle-active',
        leagueId: '00000000-0000-4000-8000-000000000001',
        publishedAt: null,
        requestedAt: timestamp,
        startedAt: timestamp,
        status: 'running',
        totalQueries: 10,
        totalRecipes: 5,
      },
      published: null,
    }));

    const response = await api.inject({ method: 'GET', url: '/api/refresh' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      correlationId: response.headers['x-request-id'],
      data: {
        active: {
          completedQueries: 7,
          failedQueries: 1,
          requestedAt: timestamp.toISOString(),
          totalQueries: 10,
        },
        published: null,
      },
    });
    await api.close();
  });

  it('exposes shared rate-limit windows and waiting time', async () => {
    const timestamp = new Date('2026-07-20T00:00:00.000Z');
    const blockedUntil = new Date(timestamp.getTime() + 10_000);
    const api = buildApi(
      pino({ level: 'silent' }),
      vi.fn(),
      async () => ({ active: null, published: null }),
      async () => [
        {
          blockedUntil,
          endpoints: ['trade-search', 'trade-fetch'],
          lastResponseAt: timestamp,
          lastStatus: 429,
          minimumDelayMs: 1100,
          nextRequestAt: timestamp,
          policy: 'trade-search-request-limit',
          updatedAt: timestamp,
          windows: [
            {
              activeRestrictionSeconds: 10,
              currentHits: 11,
              maximumHits: 10,
              periodSeconds: 5,
              restrictionSeconds: 10,
              rule: 'client',
            },
          ],
        },
      ],
    );

    const response = await api.inject({
      method: 'GET',
      url: '/api/diagnostics/rate-limits',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        policies: [
          {
            blockedUntil: blockedUntil.toISOString(),
            minimumDelayMs: 1100,
            waitingUntil: blockedUntil.toISOString(),
          },
        ],
      },
    });
    await api.close();
  });

  it('serves catalog and recipe resource readers', async () => {
    const timestamp = '2026-07-20T00:00:00.000Z';
    const catalog = vi.fn(async (correlationId: string) => ({
      correlationId,
      data: { entries: [] },
      errorCode: null as null,
      isStale: false as const,
      lastSuccessfulAt: timestamp,
      publishedAt: timestamp,
      refreshStatus: 'published' as const,
      state: 'success' as const,
    }));
    const recipe = vi.fn(async () => {
      throw new DomainError('PERSISTENCE_NOT_FOUND');
    });
    const api = buildApi(
      pino({ level: 'silent' }),
      vi.fn(),
      async () => ({ active: null, published: null }),
      async () => [],
      catalog,
      recipe,
    );

    const catalogResponse = await api.inject({
      method: 'GET',
      url: '/api/catalog',
    });
    const recipeResponse = await api.inject({
      method: 'GET',
      url: '/api/recipes/missing',
    });

    expect(catalogResponse.statusCode).toBe(200);
    expect(catalogResponse.json()).toMatchObject({ state: 'success' });
    expect(catalog).toHaveBeenCalledWith(
      catalogResponse.headers['x-request-id'],
    );
    expect(recipeResponse.statusCode).toBe(404);
    await api.close();
  });
});
