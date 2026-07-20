import { createInMemoryRepositories } from '@poe-worksmith/domain';
import { describe, expect, it, vi } from 'vitest';

import {
  GggRateLimitController,
  parseRateLimitHeaders,
} from './rateLimitController.js';

const start = new Date('2026-07-20T00:00:00.000Z');

describe('GGG rate-limit controller', () => {
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
    expect(sleep).toHaveBeenCalledWith(10_000);
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
});
