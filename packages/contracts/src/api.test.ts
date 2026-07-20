import { describe, expect, it } from 'vitest';

import {
  apiErrorEnvelopeSchema,
  catalogResponseSchema,
  publicDomainErrorSchema,
  rateLimitDiagnosticsResponseSchema,
  refreshProgressResponseSchema,
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

  it('validates complete refresh progress for active and published cycles', () => {
    const cycle = {
      completedQueries: 8,
      completedRecipes: 3,
      failedQueries: 1,
      failedRecipes: 0,
      finishedAt: null,
      id: 'cycle-active',
      publishedAt: null,
      requestedAt: timestamp,
      startedAt: timestamp,
      status: 'running' as const,
      totalQueries: 12,
      totalRecipes: 5,
    };

    expect(
      refreshProgressResponseSchema.parse({
        correlationId,
        data: { active: cycle, published: null },
      }),
    ).toMatchObject({ data: { active: { completedQueries: 8 } } });
    expect(() =>
      refreshProgressResponseSchema.parse({
        correlationId,
        data: {
          active: { ...cycle, completedQueries: 12, failedQueries: 1 },
          published: null,
        },
      }),
    ).toThrow();
  });

  it('validates rate-limit diagnostics without hiding policy windows', () => {
    const response = {
      correlationId,
      data: {
        policies: [
          {
            blockedUntil: timestamp,
            endpoints: ['trade-search'],
            lastResponseAt: timestamp,
            lastStatus: 429,
            minimumDelayMs: 1000,
            nextRequestAt: timestamp,
            policy: 'trade-policy',
            updatedAt: timestamp,
            waitingUntil: timestamp,
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
      },
    };

    expect(rateLimitDiagnosticsResponseSchema.parse(response)).toEqual(
      response,
    );
  });
});
