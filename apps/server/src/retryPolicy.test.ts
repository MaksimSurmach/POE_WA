import { DomainError } from '@poe-worksmith/domain';
import { describe, expect, it } from 'vitest';

import { ProviderRetryPolicy } from './retryPolicy.js';

describe('provider retry policy', () => {
  it('applies bounded exponential backoff with equal jitter', () => {
    const policy = new ProviderRetryPolicy({
      baseDelayMs: 1000,
      maximumDelayMs: 4000,
      random: () => 0,
    });
    const error = new DomainError('PROVIDER_UNAVAILABLE');

    expect(policy.decide(error, 1, 10)).toEqual({
      delayMs: 500,
      retry: true,
    });
    expect(policy.decide(error, 2, 10)).toEqual({
      delayMs: 1000,
      retry: true,
    });
    expect(policy.decide(error, 8, 10)).toEqual({
      delayMs: 2000,
      retry: true,
    });
  });

  it('uses distinct rate-limit and open-circuit timings', () => {
    const policy = new ProviderRetryPolicy({
      baseDelayMs: 1000,
      random: () => 1,
    });

    expect(
      policy.decide(new DomainError('PROVIDER_RATE_LIMITED'), 2, 3),
    ).toEqual({ delayMs: 10_000, retry: true });
    expect(
      policy.decide(new DomainError('PROVIDER_CIRCUIT_OPEN'), 1, 3),
    ).toEqual({ delayMs: 30_000, retry: true });
  });

  it('never retries permanent, schema, or exhausted errors', () => {
    const policy = new ProviderRetryPolicy({ baseDelayMs: 1000 });

    expect(
      policy.decide(new DomainError('PROVIDER_AUTH_FAILED'), 1, 3),
    ).toEqual({ delayMs: 0, retry: false });
    expect(
      policy.decide(new DomainError('PROVIDER_RESPONSE_INVALID'), 1, 3),
    ).toEqual({ delayMs: 0, retry: false });
    expect(
      policy.decide(new DomainError('PROVIDER_UNAVAILABLE'), 3, 3),
    ).toEqual({ delayMs: 0, retry: false });
  });
});
