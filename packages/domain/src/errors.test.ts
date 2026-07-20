import { describe, expect, it } from 'vitest';

import {
  allowsDegradedResult,
  type DomainErrorCode,
  DomainError,
  domainErrorDefinitions,
  failure,
  isRetryable,
  serializeDomainError,
  success,
} from './errors.js';

describe('domain error taxonomy', () => {
  it('constructs every stable code with its declared classification', () => {
    for (const [code, definition] of Object.entries(domainErrorDefinitions)) {
      const error = new DomainError(code as DomainErrorCode);

      expect(error).toMatchObject({
        category: definition.category,
        code,
        disposition: definition.disposition,
        message: definition.publicMessage,
      });
    }
  });

  it('drives retry and degraded decisions from disposition', () => {
    const retryable = new DomainError('PROVIDER_RATE_LIMITED');
    const permanent = new DomainError('MARKET_QUERY_INVALID');
    const degraded = new DomainError('NO_LISTINGS');

    expect(isRetryable(retryable)).toBe(true);
    expect(isRetryable(permanent)).toBe(false);
    expect(allowsDegradedResult(degraded)).toBe(true);
    expect(allowsDegradedResult(retryable)).toBe(false);
  });

  it('serializes a safe public envelope without its internal cause', () => {
    const cause = new Error('token=super-secret provider response');
    const error = new DomainError('PROVIDER_UNAVAILABLE', { cause });
    const serialized = serializeDomainError(error);

    expect(error.cause).toBe(cause);
    expect(serialized).toEqual({
      category: 'market',
      code: 'PROVIDER_UNAVAILABLE',
      disposition: 'retryable',
      message: 'The market provider is temporarily unavailable.',
      retryable: true,
    });
    expect(JSON.stringify(error)).toBe(JSON.stringify(serialized));
    expect(JSON.stringify(error)).not.toContain('super-secret');
  });

  it('provides a discriminated result model', () => {
    const ok = success({ recipeId: 'physical-large-cluster' });
    const failed = failure(new DomainError('CALCULATION_FAILED'));

    expect(ok).toEqual({
      ok: true,
      value: { recipeId: 'physical-large-cluster' },
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('CALCULATION_FAILED');
    }
  });
});
