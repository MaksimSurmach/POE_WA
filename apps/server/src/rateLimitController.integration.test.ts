import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import { GggRateLimitController } from './rateLimitController.js';
import { createPostgresRepositories } from './repositories/index.js';

const pool = createDatabasePool(loadDatabaseConfig());
const repositories = createPostgresRepositories(pool);
const start = new Date('2026-07-20T00:00:00.000Z');

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    'truncate table rate_limit_endpoint_policies, rate_limit_states cascade',
  );
});

describe('PostgreSQL GGG rate-limit coordination', () => {
  it('blocks a second controller and shares one policy across endpoints', async () => {
    let now = start;
    const sleep = vi.fn(async (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
    });
    const first = new GggRateLimitController({
      clock: () => now,
      repository: repositories.rateLimits,
      sleep,
    });
    const second = new GggRateLimitController({
      clock: () => now,
      repository: repositories.rateLimits,
      sleep,
    });
    const headers = new Headers({
      'Retry-After': '10',
      'X-Rate-Limit-Client': '10:5:10',
      'X-Rate-Limit-Client-State': '11:5:10',
      'X-Rate-Limit-Policy': 'trade-policy',
      'X-Rate-Limit-Rules': 'client',
    });

    await first.observeResponse('trade-search', { headers, status: 429 });
    await second.waitForPermit('trade-search');
    const recoveredHeaders = new Headers(headers);
    recoveredHeaders.set('Retry-After', '0');
    recoveredHeaders.set('X-Rate-Limit-Client-State', '1:5:0');
    await second.observeResponse('trade-fetch', {
      headers: recoveredHeaders,
      status: 200,
    });

    expect(sleep).toHaveBeenCalledWith(10_000);
    expect(await repositories.rateLimits.list()).toMatchObject([
      {
        endpoints: ['trade-fetch', 'trade-search'],
        policy: 'trade-policy',
        windows: [
          {
            currentHits: 1,
            maximumHits: 10,
            periodSeconds: 5,
          },
        ],
      },
    ]);
  });
});
