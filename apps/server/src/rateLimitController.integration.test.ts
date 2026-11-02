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
  it('retains all trade policies and known windows through headerless responses', async () => {
    let now = start;
    const repository = repositories.rateLimits;
    const sleep = vi.fn(async (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
    });
    const gate = new GggRateLimitController({
      repository,
      clock: () => now,
      sleep,
    });
    const strict = new Headers({
      'X-Rate-Limit-Policy': 'strict-search',
      'X-Rate-Limit-Rules': 'client',
      'X-Rate-Limit-Client': '1:10:10',
      'X-Rate-Limit-Client-State': '0:10:0',
    });
    await gate.observeResponse('trade-search', {
      status: 200,
      headers: strict,
    });
    await gate.observeResponse('trade-fetch', {
      status: 200,
      headers: new Headers({
        'X-Rate-Limit-Policy': 'fast-fetch',
        'X-Rate-Limit-Rules': 'client',
        'X-Rate-Limit-Client': '10:1:1',
        'X-Rate-Limit-Client-State': '0:1:0',
      }),
    });
    await gate.observeResponse('trade-search', {
      status: 200,
      headers: new Headers(),
    });
    const reopened = new GggRateLimitController({
      repository,
      clock: () => now,
      sleep,
    });
    await reopened.waitForPermit('trade-fetch');
    await reopened.waitForPermit('trade-search');
    expect(now.getTime() - start.getTime()).toBe(22_000);
    expect(
      (await repository.list()).find(
        ({ policy }) => policy === 'strict-search',
      ),
    ).toMatchObject({
      minimumDelayMs: 11_000,
      windows: [{ maximumHits: 1, periodSeconds: 10 }],
    });
    strict.set('X-Rate-Limit-Client', '10:1:1');
    strict.set('X-Rate-Limit-Client-State', '0:1:0');
    await gate.observeResponse('trade-search', {
      status: 200,
      headers: strict,
    });
    expect(
      (await repository.list()).find(({ policy }) => policy === 'strict-search')
        ?.minimumDelayMs,
    ).toBe(1000);
  });

  it('retains a denial after a late successful response and policy change', async () => {
    const repository = repositories.rateLimits;
    const gate = new GggRateLimitController({ repository });
    await gate.observeResponse('trade-search', {
      status: 403,
      headers: new Headers(),
    });
    await gate.observeResponse('trade-search', {
      status: 200,
      headers: new Headers({
        'X-Rate-Limit-Policy': 'new-policy',
        'X-Rate-Limit-Rules': 'client',
        'X-Rate-Limit-Client': '10:1:1',
        'X-Rate-Limit-Client-State': '0:1:0',
      }),
    });
    await expect(
      new GggRateLimitController({ repository }).waitForPermit('trade-fetch'),
    ).rejects.toMatchObject({ code: 'MARKET_ACCESS_BLOCKED' });
  });

  it('persists Retry-After on a 503 across controllers', async () => {
    const repository = repositories.rateLimits;
    let now = start;
    await new GggRateLimitController({
      repository,
      clock: () => now,
    }).observeResponse('trade-search', {
      status: 503,
      headers: new Headers({ 'Retry-After': '120' }),
    });
    const gate = new GggRateLimitController({
      repository,
      clock: () => now,
      sleep: async (milliseconds) => {
        now = new Date(now.getTime() + milliseconds);
      },
    });
    await gate.waitForPermit('trade-fetch');
    expect(now.getTime() - start.getTime()).toBe(120_000);
  });

  it.each([401, 403])(
    'keeps denial %s across a new pool and controller',
    async (status) => {
      const first = new GggRateLimitController({
        repository: repositories.rateLimits,
      });
      await first.observeResponse('trade-search', {
        status,
        headers: new Headers(),
      });
      const reopenedPool = createDatabasePool(loadDatabaseConfig());
      try {
        const reopened = new GggRateLimitController({
          repository: createPostgresRepositories(reopenedPool).rateLimits,
        });
        await expect(
          reopened.waitForPermit('trade-fetch'),
        ).rejects.toMatchObject({ code: 'MARKET_ACCESS_BLOCKED' });
      } finally {
        await reopenedPool.end();
      }
    },
  );

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
      { policy: 'legacy-search-policy', endpoints: ['trade-search'] },
    ]);
  });

  it('shares a 429 cooldown with a separate Node process', async () => {
    const controller = new GggRateLimitController({
      repository: repositories.rateLimits,
    });
    await controller.observeResponse('trade-search', {
      headers: new Headers({
        'Retry-After': '2',
        'X-Rate-Limit-Client': '10:5:2',
        'X-Rate-Limit-Client-State': '11:5:2',
        'X-Rate-Limit-Policy': 'process-shared-policy',
        'X-Rate-Limit-Rules': 'client',
      }),
      status: 429,
    });
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
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
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
    expect(
      Number(stdout.match(/permit-delay-ms=(\d+)/)?.[1]),
    ).toBeGreaterThanOrEqual(1_700);
    expect(await repositories.rateLimits.list()).toMatchObject([
      {
        policy: 'process-shared-policy',
        endpoints: ['trade-fetch', 'trade-search'],
      },
    ]);
  }, 15_000);
});
