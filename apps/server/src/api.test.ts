import { apiErrorEnvelopeSchema } from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { buildApi } from './api.js';

describe('health API', () => {
  it('reports liveness without external dependencies', async () => {
    const api = buildApi(pino({ level: 'silent' }), vi.fn());

    const response = await api.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      correlationId: response.headers['x-request-id'],
      status: 'ok',
    });
    await api.close();
  });

  it('reports database readiness and failure', async () => {
    const readyApi = buildApi(pino({ level: 'silent' }), vi.fn());
    const unavailableApi = buildApi(pino({ level: 'silent' }), async () => {
      throw new Error('unavailable');
    });

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
    const api = buildApi(pino({ level: 'silent' }), vi.fn());
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
});
