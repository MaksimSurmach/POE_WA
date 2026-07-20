import { createInMemoryRepositories, DomainError } from '@poe-worksmith/domain';
import { describe, expect, it, vi } from 'vitest';

import { ProviderCircuitBreaker } from './circuitBreaker.js';

const start = new Date('2026-07-20T00:00:00.000Z');

describe('provider circuit breaker', () => {
  it('opens after the threshold and sends no request during cooldown', async () => {
    const repositories = createInMemoryRepositories();
    let now = start;
    const breaker = new ProviderCircuitBreaker({
      clock: () => now,
      cooldownMs: 10_000,
      failureThreshold: 2,
      probeLeaseMs: 5000,
      provider: 'poe-trade',
      repository: repositories.providerCircuits,
    });
    const outbound = vi.fn();
    const request = async () => {
      await breaker.beforeRequest('trade-search');
      outbound();
    };

    await breaker.recordFailure(
      'trade-search',
      new DomainError('PROVIDER_UNAVAILABLE'),
    );
    expect(
      await breaker.recordFailure(
        'trade-search',
        new DomainError('PROVIDER_UNAVAILABLE'),
      ),
    ).toMatchObject({ consecutiveFailures: 2, status: 'open' });

    await expect(request()).rejects.toMatchObject({
      code: 'PROVIDER_CIRCUIT_OPEN',
    });
    expect(outbound).not.toHaveBeenCalled();

    now = new Date(start.getTime() + 10_000);
    await expect(breaker.beforeRequest('trade-search')).resolves.toMatchObject({
      status: 'half_open',
    });
    await expect(breaker.beforeRequest('trade-search')).rejects.toMatchObject({
      code: 'PROVIDER_CIRCUIT_OPEN',
    });

    await breaker.recordSuccess('trade-search');
    await expect(breaker.beforeRequest('trade-search')).resolves.toMatchObject({
      consecutiveFailures: 0,
      status: 'closed',
    });
  });

  it('does not trip on permanent or schema errors', async () => {
    const repositories = createInMemoryRepositories();
    const breaker = new ProviderCircuitBreaker({
      clock: () => start,
      failureThreshold: 1,
      provider: 'poe-trade',
      repository: repositories.providerCircuits,
    });

    await breaker.recordFailure(
      'trade-search',
      new DomainError('PROVIDER_AUTH_FAILED'),
    );
    await breaker.recordFailure(
      'trade-search',
      new DomainError('PROVIDER_RESPONSE_INVALID'),
    );

    await expect(breaker.beforeRequest('trade-search')).resolves.toMatchObject({
      consecutiveFailures: 0,
      status: 'closed',
    });
  });
});
