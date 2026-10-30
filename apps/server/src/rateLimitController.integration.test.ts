import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';

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

    expect(sleep).toHaveBeenCalledWith(10_000, undefined);
    expect(await repositories.rateLimits.list()).toMatchObject([
      {
        endpoints: ['trade'],
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

  it('honors the strictest persisted cooldown across old trade endpoint keys', async () => {
    for (const [endpoint, policy, delay] of [
      ['trade-fetch', 'legacy-fetch-policy', 2_000],
      ['trade-search', 'legacy-search-policy', 5_000],
    ] as const) {
      await repositories.rateLimits.observe({
        blockedUntil: new Date(start.getTime() + delay),
        endpoint,
        fallbackPolicy: 'poe-trade',
        minimumDelayMs: 1_000,
        now: start,
        policy,
        status: 429,
        windows: [],
      });
    }
    let now = start;
    const sleep = vi.fn(async (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
    });
    const controller = new GggRateLimitController({
      clock: () => now,
      repository: repositories.rateLimits,
      sleep,
    });
    await controller.waitForPermit('trade-search');
    expect(sleep).toHaveBeenCalledWith(5_000, undefined);
    expect(
      (await repositories.rateLimits.list()).map(({ policy, endpoints }) => ({
        policy,
        endpoints,
      })),
    ).toEqual([
      { policy: 'legacy-fetch-policy', endpoints: ['trade-fetch'] },
      { policy: 'legacy-search-policy', endpoints: ['trade', 'trade-search'] },
    ]);
  });

  it('shares a 429 cooldown with a separate Node process', async () => {
    const controller = new GggRateLimitController({
      repository: repositories.rateLimits,
    });
    await controller.observeResponse(
      'trade-search',
      {
        headers: new Headers({
          'Retry-After': '2',
          'X-Rate-Limit-Client': '10:5:2',
          'X-Rate-Limit-Client-State': '11:5:2',
          'X-Rate-Limit-Policy': 'process-shared-policy',
          'X-Rate-Limit-Rules': 'client',
        }),
        status: 429,
      },
    );
    const script = `
      import { loadDatabaseConfig } from './dist/config.js';
      import { createDatabasePool } from './dist/database.js';
      import { GggRateLimitController } from './dist/rateLimitController.js';
      import { createPostgresRepositories } from './dist/repositories/index.js';
      const pool = createDatabasePool(loadDatabaseConfig());
      const gate = new GggRateLimitController({ repository: createPostgresRepositories(pool).rateLimits });
      const started = Date.now();
      await gate.waitForPermit('trade-fetch');
      console.log('permit-delay-ms=' + (Date.now() - started));
      const headers = new Headers({
        'Retry-After': '0',
        'X-Rate-Limit-Client': '10:5:10',
        'X-Rate-Limit-Client-State': '1:5:0',
        'X-Rate-Limit-Policy': 'process-shared-policy',
        'X-Rate-Limit-Rules': 'client',
      });
      await gate.observeResponse('trade-fetch', { headers, status: 200 });
      await pool.end();
    `;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', script],
      { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    const [code] = await new Promise<[number | null]>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve([exitCode]));
    });
    expect(code, stderr).toBe(0);
    expect(Number(stdout.match(/permit-delay-ms=(\d+)/)?.[1])).toBeGreaterThanOrEqual(1_700);
    expect(await repositories.rateLimits.list()).toMatchObject([
      { policy: 'process-shared-policy', endpoints: ['trade'] },
    ]);
  }, 15_000);
});
