import { createInMemoryRepositories } from '@poe-worksmith/domain';
import { describe, expect, it, vi } from 'vitest';

import {
  GggRateLimitController,
  parseRateLimitHeaders,
} from './rateLimitController.js';

const start = new Date('2026-07-20T00:00:00.000Z');

describe('GGG rate-limit controller', () => {
  it('keeps ordinary pacing when a slow policy has no provider block', async () => {
    const repository = createInMemoryRepositories().rateLimits;
    let now = start;
    const gate = new GggRateLimitController({
      repository,
      conservativeDelayMs: 10_000,
      clock: () => now,
      sleep: async (ms) => {
        now = new Date(now.getTime() + ms);
      },
    });
    await gate.waitForPermit('trade-search');
    await gate.waitForPermit('trade-search', undefined, {
      deferProviderBlock: true,
    });
    expect(now).toEqual(new Date(start.getTime() + 10_000));
  });

  it('defers the aggregate cooldown when a different policy governs the permit state', async () => {
    const repository = createInMemoryRepositories().rateLimits;
    let now = start;
    const gate = new GggRateLimitController({
      repository,
      clock: () => now,
      sleep: async (ms) => {
        now = new Date(now.getTime() + ms);
      },
    });
    await gate.observeResponse('trade-search', {
      status: 200,
      headers: new Headers({
        'X-Rate-Limit-Policy': 'trade-search-request-limit',
      }),
    });
    await gate.observeResponse('trade-fetch', {
      status: 429,
      headers: new Headers({
        'X-Rate-Limit-Policy': 'trade-fetch-request-limit',
        'Retry-After': '120',
      }),
    });
    await expect(
      gate.waitForPermit('trade', undefined, { deferProviderBlock: true }),
    ).rejects.toMatchObject({ retryAt: new Date(start.getTime() + 120_000) });
    expect(now).toEqual(start);
  });

  it('does not import ordinary generic pacing or a named search cooldown into exchange', async () => {
    const repository = createInMemoryRepositories().rateLimits;
    const old = new GggRateLimitController({ repository, clock: () => start });
    await old.observeResponse('trade-search', {
      status: 200,
      headers: new Headers(),
    });
    expect(
      (await repository.list())
        .find((s) => s.policy === 'poe-trade')
        ?.nextRequestAt.getTime(),
    ).toBeGreaterThan(start.getTime());
    await old.observeResponse('trade-search', {
      status: 429,
      headers: new Headers({
        'X-Rate-Limit-Policy': 'trade-search-request-limit',
        'Retry-After': '120',
      }),
    });
    let now = start;
    const gate = new GggRateLimitController({
      repository,
      clock: () => now,
      sleep: async (ms) => {
        now = new Date(now.getTime() + ms);
      },
    });
    await gate.waitForPermit('trade-exchange');
    expect(now).toEqual(start);
  });

  it.each([
    [429, false],
    [429, true],
    [503, false],
    [503, true],
  ] as const)(
    'preserves generic Retry-After before first exchange permit: status=%s orphan=%s',
    async (status, orphaned) => {
      const repository = createInMemoryRepositories().rateLimits;
      let now = start;
      const old = new GggRateLimitController({ repository, clock: () => now });
      await old.observeResponse('trade-search', {
        status,
        headers: new Headers({ 'Retry-After': '120' }),
      });
      if (orphaned)
        await old.observeResponse('trade-search', {
          status: 200,
          headers: new Headers({
            'X-Rate-Limit-Policy': 'trade-search-request-limit',
            'X-Rate-Limit-Rules': 'client',
            'X-Rate-Limit-Client': '10:1:1',
            'X-Rate-Limit-Client-State': '0:1:0',
          }),
        });
      const gate = new GggRateLimitController({
        repository,
        clock: () => now,
        sleep: async (ms) => {
          now = new Date(now.getTime() + ms);
        },
      });
      await gate.waitForPermit('trade-exchange');
      expect(now.getTime() - start.getTime()).toBe(120_000);
    },
  );

  it.each([
    ['trade-search', 'trade-exchange'],
    ['trade-exchange', 'trade-search'],
    ['trade-exchange', 'trade-fetch'],
  ])(
    'shares access denial from %s with %s without sharing pacing',
    async (denied, next) => {
      const repository = createInMemoryRepositories().rateLimits;
      await new GggRateLimitController({ repository }).observeResponse(denied, {
        status: 403,
        headers: new Headers({
          'X-Rate-Limit-Policy': `${denied}-request-limit`,
        }),
      });
      await expect(
        new GggRateLimitController({ repository }).waitForPermit(next),
      ).rejects.toMatchObject({ code: 'MARKET_ACCESS_BLOCKED' });
    },
  );

  it.each(['trade-search', 'trade-fetch', 'trade-exchange'])(
    'blocks %s when only an orphaned retained exchange-policy denial is visible',
    async (endpoint) => {
      const repository = createInMemoryRepositories().rateLimits;
      const old = new GggRateLimitController({ repository });
      const headers = new Headers({
        'X-Rate-Limit-Policy': 'trade-exchange-request-limit',
      });
      await old.observeResponse('trade-search', { status: 403, headers });
      headers.set('X-Rate-Limit-Policy', 'trade-search-request-limit');
      await old.observeResponse('trade-search', { status: 200, headers });
      const orphaned = (await repository.list()).filter(
        (state) => state.policy === 'trade-exchange-request-limit',
      );
      expect(orphaned).toMatchObject([{ endpoints: [], lastStatus: 403 }]);
      const acquire = vi.spyOn(repository, 'acquire');
      const gate = new GggRateLimitController({
        repository: { ...repository, list: async () => orphaned },
      });
      await expect(gate.waitForPermit(endpoint)).rejects.toMatchObject({
        code: 'MARKET_ACCESS_BLOCKED',
      });
      expect(acquire).not.toHaveBeenCalled();
    },
  );

  it.each([429, 401, 403])(
    'preserves an orphaned legacy exchange restriction before the new endpoint first responds: %s',
    async (status) => {
      const repository = createInMemoryRepositories().rateLimits;
      let now = start;
      const old = new GggRateLimitController({ repository, clock: () => now });
      const headers = new Headers({
        'X-Rate-Limit-Policy': 'trade-exchange-request-limit',
        'X-Rate-Limit-Rules': 'client',
        'X-Rate-Limit-Client': '10:1:1',
        'X-Rate-Limit-Client-State': '0:1:0',
        ...(status === 429 ? { 'Retry-After': '120' } : {}),
      });
      await old.observeResponse('trade-search', { status, headers });
      headers.set('X-Rate-Limit-Policy', 'trade-search-request-limit');
      headers.delete('Retry-After');
      await old.observeResponse('trade-search', { status: 200, headers });
      const gate = new GggRateLimitController({
        repository,
        clock: () => now,
        sleep: async (ms) => {
          now = new Date(now.getTime() + ms);
        },
      });
      if (status === 429) {
        await gate.waitForPermit('trade-exchange');
        expect(now.getTime() - start.getTime()).toBe(120_000);
        expect(
          (await repository.list()).find(
            (s) => s.policy === 'trade-exchange-request-limit',
          ),
        ).toMatchObject({ endpoints: ['trade-exchange'], lastStatus: status });
      } else {
        await expect(
          gate.waitForPermit('trade-exchange'),
        ).rejects.toMatchObject({ code: 'MARKET_ACCESS_BLOCKED' });
        expect(now).toEqual(start);
        expect(
          (await repository.list()).some((s) => s.lastStatus === status),
        ).toBe(true);
      }
    },
  );

  it('retains all trade policies and known windows through headerless responses', async () => {
    let now = start;
    const repository = createInMemoryRepositories().rateLimits;
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
    const repository = createInMemoryRepositories().rateLimits;
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
    const repository = createInMemoryRepositories().rateLimits;
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
    'retains access denial %s across controller restarts and endpoints',
    async (status) => {
      const repository = createInMemoryRepositories().rateLimits;
      const first = new GggRateLimitController({ repository });
      await first.observeResponse('trade-search', {
        status,
        headers: new Headers(),
      });
      const reopened = new GggRateLimitController({ repository });
      await expect(reopened.waitForPermit('trade-fetch')).rejects.toMatchObject(
        { code: 'MARKET_ACCESS_BLOCKED' },
      );
    },
  );

  it('parses multiple rules and policy windows into conservative pacing', () => {
    const headers = new Headers({
      'X-Rate-Limit-Client': '10:10:30',
      'X-Rate-Limit-Client-State': '3:10:0',
      'X-Rate-Limit-Ip': '20:5:60,100:60:120',
      'X-Rate-Limit-Ip-State': '2:5:0,10:60:0',
      'X-Rate-Limit-Policy': 'Trade-Search-Request-Limit',
      'X-Rate-Limit-Rules': 'Ip, Client',
    });

    expect(parseRateLimitHeaders(headers, { now: start, status: 200 })).toEqual(
      {
        blockedForMs: 0,
        headersComplete: true,
        minimumDelayMs: 1100,
        policy: 'trade-search-request-limit',
        windows: [
          {
            activeRestrictionSeconds: 0,
            currentHits: 2,
            maximumHits: 20,
            periodSeconds: 5,
            restrictionSeconds: 60,
            rule: 'ip',
          },
          {
            activeRestrictionSeconds: 0,
            currentHits: 10,
            maximumHits: 100,
            periodSeconds: 60,
            restrictionSeconds: 120,
            rule: 'ip',
          },
          {
            activeRestrictionSeconds: 0,
            currentHits: 3,
            maximumHits: 10,
            periodSeconds: 10,
            restrictionSeconds: 30,
            rule: 'client',
          },
        ],
      },
    );
  });

  it('shares Retry-After blocking and request pacing across controllers', async () => {
    const repositories = createInMemoryRepositories();
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

    await first.observeResponse('trade-search', {
      headers: new Headers({
        'Retry-After': '10',
        'X-Rate-Limit-Client': '10:5:10',
        'X-Rate-Limit-Client-State': '11:5:10',
        'X-Rate-Limit-Policy': 'trade-policy',
        'X-Rate-Limit-Rules': 'client',
      }),
      status: 429,
    });
    await second.waitForPermit('trade-search');

    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(10_000, undefined);
    expect(now).toEqual(new Date(start.getTime() + 10_000));
    expect(await repositories.rateLimits.list()).toMatchObject([
      {
        blockedUntil: new Date(start.getTime() + 10_000),
        endpoints: ['trade-search'],
        lastStatus: 429,
        policy: 'trade-policy',
      },
    ]);
  });

  it('merges endpoints that report one shared policy', async () => {
    const repositories = createInMemoryRepositories();
    const controller = new GggRateLimitController({
      clock: () => start,
      repository: repositories.rateLimits,
    });
    const response = {
      headers: new Headers({
        'X-Rate-Limit-Client': '20:5:60',
        'X-Rate-Limit-Client-State': '1:5:0',
        'X-Rate-Limit-Policy': 'trade-policy',
        'X-Rate-Limit-Rules': 'client',
      }),
      status: 200,
    };

    await controller.observeResponse('trade-search', response);
    await controller.observeResponse('trade-fetch', response);

    expect(await repositories.rateLimits.list()).toMatchObject([
      {
        endpoints: ['trade-search', 'trade-fetch'],
        policy: 'trade-policy',
      },
    ]);
  });

  it('separates independent collector pacing and merges a reported shared policy', async () => {
    const repository = createInMemoryRepositories().rateLimits;
    let now = start;
    const observe = new GggRateLimitController({
      repository,
      clock: () => now,
      safetyFactor: 4 / 3,
      missingHeadersDelayMs: 30_000,
    });
    const options = { collector: true } as const;
    const reply = (policy: string) => ({
      status: 200,
      headers: new Headers({
        'x-rate-limit-policy': policy,
        'x-rate-limit-rules': 'ip',
        'x-rate-limit-ip': '3:5:10,600:10800:120',
        'x-rate-limit-ip-state': '1:5:0,100:10800:0',
      }),
    });
    await observe.observeResponse('trade-search', reply('search'), options);
    await observe.observeResponse('trade-fetch', reply('fetch'), options);
    now = new Date(start.getTime() + 24_000);
    const resumed = new GggRateLimitController({
      repository,
      clock: () => now,
      sleep: async (ms) => {
        now = new Date(now.getTime() + ms);
      },
    });
    await resumed.waitForPermit('trade-search', undefined, options);
    await resumed.waitForPermit('trade-fetch', undefined, options);
    expect(now.getTime() - start.getTime()).toBe(24_000);

    await observe.observeResponse('trade-fetch', reply('search'), options);
    const before = now.getTime();
    await resumed.waitForPermit('trade-search', undefined, options);
    await resumed.waitForPermit('trade-fetch', undefined, options);
    expect(now.getTime() - before).toBe(48_000);
  });

  it('preserves retained windows when only one state in an updated header parses', async () => {
    const repository = createInMemoryRepositories().rateLimits;
    const gate = new GggRateLimitController({
      repository,
      clock: () => start,
      missingHeadersDelayMs: 30_000,
    });
    const headers = new Headers({
      'x-rate-limit-policy': 'search',
      'x-rate-limit-rules': 'ip',
      'x-rate-limit-ip': '3:5:10,600:10800:120',
      'x-rate-limit-ip-state': '1:5:0,100:10800:0',
    });
    await gate.observeResponse(
      'trade-search',
      { status: 200, headers },
      { collector: true },
    );
    headers.set('x-rate-limit-ip-state', '1:5:15,:10800:0');
    const state = await gate.observeResponse(
      'trade-search',
      { status: 200, headers },
      { collector: true },
    );
    expect(state.windows.map(({ periodSeconds }) => periodSeconds)).toEqual([
      5, 10800,
    ]);
    expect(state.minimumDelayMs).toBe(30_000);
    expect(state.blockedUntil.getTime() - start.getTime()).toBe(15_000);
  });

  it('uses safe defaults for malformed headers and a malformed Retry-After', () => {
    const parsed = parseRateLimitHeaders(
      new Headers({
        'Retry-After': 'eventually',
        'X-Rate-Limit-Client': 'not:a:window,10:-1:5',
        'X-Rate-Limit-Client-State': 'broken',
        'X-Rate-Limit-Policy': '<invalid>',
        'X-Rate-Limit-Rules': 'client,invalid rule',
      }),
      { now: start, status: 429 },
    );

    expect(parsed).toEqual({
      blockedForMs: 60_000,
      headersComplete: false,
      minimumDelayMs: 1000,
      policy: 'poe-trade',
      windows: [],
    });
  });

  it('waits for the policy window before sending the request that would exceed it', () => {
    const parsed = parseRateLimitHeaders(
      new Headers({
        'X-Rate-Limit-Client': '10:5:10',
        'X-Rate-Limit-Client-State': '10:5:0',
        'X-Rate-Limit-Rules': 'client',
      }),
      { now: start, status: 200 },
    );

    expect(parsed.blockedForMs).toBe(5000);
  });

  it('cancels a cooldown wait without acquiring a request permit', async () => {
    const repositories = createInMemoryRepositories();
    const controller = new GggRateLimitController({
      repository: repositories.rateLimits,
    });
    await controller.observeResponse('trade-search', {
      headers: new Headers({ 'Retry-After': '60' }),
      status: 429,
    });
    const abortController = new AbortController();
    const waiting = controller.waitForPermit(
      'trade-search',
      abortController.signal,
    );
    abortController.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });
});
