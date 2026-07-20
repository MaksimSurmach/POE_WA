import { describe, expect, it } from 'vitest';

import {
  apiErrorEnvelopeSchema,
  catalogResponseSchema,
  publicDomainErrorSchema,
} from './index.js';

const correlationId = '11111111-1111-4111-8111-111111111111';
const timestamp = '2026-07-20T00:00:00.000Z';
const providerError = {
  category: 'market' as const,
  code: 'PROVIDER_UNAVAILABLE' as const,
  disposition: 'retryable' as const,
  message: 'The market provider is temporarily unavailable.',
  retryable: true,
};

describe('HTTP API contracts', () => {
  it.each([
    {
      correlationId,
      data: { entries: [] },
      errorCode: null,
      isStale: false,
      lastSuccessfulAt: timestamp,
      publishedAt: timestamp,
      refreshStatus: 'published',
      state: 'success',
    },
    {
      correlationId,
      data: { entries: [] },
      errorCode: 'SNAPSHOT_EXPIRED',
      isStale: true,
      lastSuccessfulAt: timestamp,
      publishedAt: timestamp,
      refreshStatus: 'failed',
      state: 'stale',
    },
    {
      correlationId,
      data: { entries: [] },
      errorCode: 'NO_LISTINGS',
      isStale: false,
      lastSuccessfulAt: null,
      publishedAt: timestamp,
      refreshStatus: 'published',
      state: 'partial',
    },
    {
      correlationId,
      data: null,
      error: providerError,
      errorCode: providerError.code,
      isStale: false,
      lastSuccessfulAt: null,
      publishedAt: null,
      refreshStatus: 'failed',
      state: 'error',
    },
  ])('accepts the $state catalog state', (response) => {
    expect(catalogResponseSchema.parse(response)).toEqual(response);
  });

  it('distinguishes partial data from a complete absence of data', () => {
    const partial = {
      correlationId,
      data: { entries: [] },
      errorCode: 'NO_LISTINGS',
      isStale: false,
      lastSuccessfulAt: null,
      publishedAt: timestamp,
      refreshStatus: 'published',
      state: 'partial',
    };

    expect(catalogResponseSchema.parse(partial).state).toBe('partial');
    expect(() =>
      catalogResponseSchema.parse({ ...partial, data: null }),
    ).toThrow();
  });

  it('enforces one strict, correlated public error envelope', () => {
    const envelope = { correlationId, error: providerError };

    expect(apiErrorEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(() =>
      apiErrorEnvelopeSchema.parse({
        ...envelope,
        internalCause: 'token=super-secret',
      }),
    ).toThrow();
    expect(() =>
      publicDomainErrorSchema.parse({
        ...providerError,
        retryable: false,
      }),
    ).toThrow();
    expect(() =>
      publicDomainErrorSchema.parse({
        ...providerError,
        message: 'token=super-secret',
      }),
    ).toThrow();
  });

  it('requires resource errorCode to match the unified envelope', () => {
    expect(() =>
      catalogResponseSchema.parse({
        correlationId,
        data: null,
        error: providerError,
        errorCode: 'NO_LISTINGS',
        isStale: false,
        lastSuccessfulAt: null,
        publishedAt: null,
        refreshStatus: 'failed',
        state: 'error',
      }),
    ).toThrow();
  });
});
