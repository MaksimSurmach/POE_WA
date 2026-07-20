import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DomainError } from '@poe-worksmith/domain';

import { ProviderCircuitBreaker } from './circuitBreaker.js';
import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import { createPostgresRepositories } from './repositories/index.js';

const pool = createDatabasePool(loadDatabaseConfig());
const start = new Date('2026-07-20T00:00:00.000Z');

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('truncate table provider_circuits');
});

describe('PostgreSQL provider circuit coordination', () => {
  it('shares cooldown and grants only one half-open probe', async () => {
    let now = start;
    const first = new ProviderCircuitBreaker({
      clock: () => now,
      cooldownMs: 1000,
      failureThreshold: 1,
      probeLeaseMs: 1000,
      provider: 'poe-trade',
      repository: createPostgresRepositories(pool).providerCircuits,
    });
    const second = new ProviderCircuitBreaker({
      clock: () => now,
      cooldownMs: 1000,
      failureThreshold: 1,
      probeLeaseMs: 1000,
      provider: 'poe-trade',
      repository: createPostgresRepositories(pool).providerCircuits,
    });

    await first.recordFailure(
      'trade-search',
      new DomainError('PROVIDER_UNAVAILABLE'),
    );
    await expect(second.beforeRequest('trade-search')).rejects.toMatchObject({
      code: 'PROVIDER_CIRCUIT_OPEN',
    });

    now = new Date(start.getTime() + 1000);
    await expect(first.beforeRequest('trade-search')).resolves.toMatchObject({
      status: 'half_open',
    });
    await expect(second.beforeRequest('trade-search')).rejects.toMatchObject({
      code: 'PROVIDER_CIRCUIT_OPEN',
    });

    await first.recordSuccess('trade-search');
    await expect(second.beforeRequest('trade-search')).resolves.toMatchObject({
      status: 'closed',
    });
  });
});
