import { createInMemoryRepositories } from '@poe-worksmith/domain';
import {
  chromium,
  type BrowserContext,
  type Response as BrowserResponse,
} from 'playwright';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuredTradeCapture } from './collectorTrade.js';
import { CollectorTelemetry } from './observability/collectorTelemetry.js';
import type { StoredMarketEconomySnapshot } from './marketEconomy.js';
import { GggRateLimitController } from './rateLimitController.js';
import {
  createTradeSessionRepository,
  TradeSessionDecryptError,
} from './repositories/tradeSessionRepository.js';

const at = new Date('2026-11-01T12:00:00.000Z');
const exchangeId = 'fcafcbbb-601d-491f-8b01-f0dd151a4b24';
const environment = {
  MARKET_COLLECTION_SOURCE: 'trade-compatible',
  POE_TRADE_ACCESS: 'owner_permitted',
  POE_TRADE_USER_AGENT: 'Worksmith test collector',
};

function target(mixed = false, slot = 'crafted-item') {
  return {
    payload: {
      provider: 'poe-trade',
      schemaVersion: 1,
      recipeIds: ['fixture'],
      query: {
        handbookTarget: JSON.stringify({
          name: 'Collector test',
          game: 'poe1',
          realm: 'pc',
          league: 'Demo',
          patch: '3.28',
          slot,
          baseTypes: ['Stygian Vise'],
          builds: [],
          requiredMods: [],
          sources: [],
          tradeSearch: {
            version: 1,
            scope: 'strict',
            status: 'available',
            currency: 'chaos',
            rarity: 'rare',
            groups: [],
            includeOtherCurrencies: mixed,
            ...(mixed ? { exchangeSnapshotId: exchangeId } : {}),
          },
        }),
      },
    },
  };
}

function listings(count: number, currency = 'chaos') {
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${i + 1}`,
    listing: {
      indexed: at.toISOString(),
      account: { name: `seller-${i}` },
      price: { amount: i + 1, currency },
    },
    item: {
      baseType: 'Stygian Vise',
      ilvl: 84,
      explicitMods: ['+90 to maximum Life'],
      note: `~price ${i + 1} ${currency}`,
    },
  }));
}

function setup(
  data: ReturnType<typeof listings>,
  options: {
    omit?: string;
    malformed?: string;
    replacement?: { requested: string; returned: string };
    inexact?: boolean;
    moveBeforeRecheck?: boolean;
    exchange?: StoredMarketEconomySnapshot;
    status?: number;
    unsliced?: string;
  } = {},
) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  const requests = { search: 0, ranged: 0, detail: 0 };
  const index = new Map(data.map((row) => [row.id, row]));
  const fetch = vi.fn(async (input: URL, init?: RequestInit) => {
    if (input.pathname.includes('/search/')) {
      requests.search++;
      if (options.status)
        return new Response(null, {
          status: options.status,
          headers: { 'Retry-After': '120' },
        });
      const { min, max, option } = JSON.parse(String(init?.body)).query.filters
        .trade_filters.filters.price;
      if (min !== undefined || max !== undefined) requests.ranged++;
      // Models Trade's named-currency option as an exact denomination match.
      const result = data.filter(
        ({ id, listing: { price } }) =>
          (!option || (price.currency === option && id !== options.unsliced)) &&
          price.amount >= (min ?? 0) &&
          price.amount <= (max ?? Infinity),
      );
      if (
        options.moveBeforeRecheck &&
        requests.ranged &&
        min === undefined &&
        max === undefined
      ) {
        const first = result.shift();
        if (first) result.push(first);
      }
      return Response.json({
        id: `q-${requests.search}`,
        result: result.slice(0, 100).map(({ id }) => id),
        total: result.length,
        inexact: options.inexact ?? false,
      });
    }
    requests.detail++;
    const ids = input.pathname
      .slice(input.pathname.lastIndexOf('/') + 1)
      .split(',');
    return Response.json(
      {
        result: ids.map((id) => {
          if (id === options.omit) return null;
          if (id === options.malformed) return { id, item: {}, listing: {} };
          return index.get(
            id === options.replacement?.requested
              ? options.replacement.returned
              : id,
          );
        }),
      },
      {
        headers:
          options.malformed && ids.includes(options.malformed)
            ? { 'X-Rate-Limit-Policy': 'collector-malformed-details' }
            : {},
      },
    );
  });
  vi.stubGlobal('fetch', fetch);
  const repository = createInMemoryRepositories().rateLimits;
  let now = at;
  const rateLimits = new GggRateLimitController({
    repository,
    clock: () => now,
    sleep: async (ms) => {
      now = new Date(now.getTime() + ms);
    },
  });
  const find = vi.fn(async () => options.exchange ?? null);
  const economy = { latest: async () => null, find };
  return { rateLimits, economy, requests, find, repository, now: () => now };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('collector Trade captures', () => {
  it('captures every returned ID, including beyond the legacy 20, from fresh requests', async () => {
    const { rateLimits, economy, requests } = setup(listings(24));
    const run = fixtureTradeCapture(rateLimits, economy, environment);
    const signal = new AbortController().signal;
    for (let i = 0; i < 2; i++)
      expect(await run(target(), signal)).toMatchObject({
        status: 'success',
        capture: { complete: true, fetched: 24, reportedTotal: 24 },
      });
    expect(requests).toEqual({ search: 2, ranged: 0, detail: 6 });
  });

  it('proves coverage across overlapping inclusive price slices', async () => {
    const { rateLimits, economy, requests } = setup(listings(180));
    const run = fixtureTradeCapture(rateLimits, economy, environment);
    const result = await run(target(), new AbortController().signal);
    expect(result).toMatchObject({
      status: 'success',
      capture: { complete: true, fetched: 180, reportedTotal: 180 },
    });
    expect(requests.ranged).toBeGreaterThanOrEqual(2);
    expect(requests.ranged).toBeLessThanOrEqual(5);
    expect(requests.search).toBe(requests.ranged + 2);
  });

  it('keeps sliced coverage partial when the fresh root sample moves with the same total', async () => {
    const { rateLimits, economy } = setup(listings(180), {
      moveBeforeRecheck: true,
    });
    const run = fixtureTradeCapture(rateLimits, economy, environment);
    expect(await run(target(), new AbortController().signal)).toMatchObject({
      status: 'success',
      capture: {
        complete: false,
        fetched: 180,
        reportedTotal: 180,
        partialReason: 'SEARCH_CHANGED_DURING_CAPTURE',
      },
    });
  });

  it('retains valid details and observes headers from a batch with a malformed row', async () => {
    const { rateLimits, economy, repository } = setup(listings(24), {
      malformed: 'id-21',
    });
    const run = fixtureTradeCapture(rateLimits, economy, environment);
    const result = await run(target(), new AbortController().signal);
    expect(result).toMatchObject({
      status: 'success',
      capture: {
        complete: false,
        fetched: 23,
        partialReason: 'DETAILS_INCOMPLETE',
        listings: expect.arrayContaining([
          expect.objectContaining({ itemId: 'id-24' }),
        ]),
      },
    });
    expect(await repository.list()).toContainEqual(
      expect.objectContaining({
        policy: 'collector-malformed-details',
        lastStatus: 200,
      }),
    );
  });

  it.each([
    ['a missing detail', { omit: 'id-21' }, 23],
    [
      'an unexpected ID',
      { replacement: { requested: 'id-21', returned: 'id-2' } },
      23,
    ],
    ['an inexact total', { inexact: true }, 24],
  ] as const)('keeps %s partial', async (_label, options, fetched) => {
    const { rateLimits, economy } = setup(listings(24), options);
    const run = fixtureTradeCapture(rateLimits, economy, environment);
    expect(await run(target(), new AbortController().signal)).toMatchObject({
      status: 'success',
      capture: {
        complete: false,
        fetched,
        partialReason: expect.any(String),
      },
    });
  });

  it.each([false, true])(
    'caps bounded requests and retains evidence when bounds cannot prove coverage (mixed=%s)',
    async (mixed) => {
      const { rateLimits, economy, requests } = setup(listings(601));
      const run = fixtureTradeCapture(rateLimits, economy, environment);
      expect(
        await run(target(mixed), new AbortController().signal),
      ).toMatchObject({
        status: 'success',
        capture: {
          complete: false,
          reportedTotal: 601,
          fetched: 298,
          partialReason: 'PRICE_SLICE_LIMIT',
        },
      });
      // Mixed spends one of the five bounded searches on the chaos denomination.
      expect(requests.ranged).toBe(mixed ? 4 : 5);
      expect(requests.search).toBe(6);
    },
  );

  const mixedListings = (extra: ReturnType<typeof listings> = []) => [
    ...listings(150),
    ...listings(60, 'divine').map((row) => ({ ...row, id: `div-${row.id}` })),
    ...extra,
  ];

  it('proves mixed chaos and divine coverage above 100 by denomination', async () => {
    const { rateLimits, economy, requests } = setup(mixedListings());
    const run = fixtureTradeCapture(rateLimits, economy, environment);
    expect(await run(target(true), new AbortController().signal)).toMatchObject(
      {
        status: 'success',
        capture: {
          complete: true,
          partialReason: null,
          fetched: 210,
          reportedTotal: 210,
          slices: 4,
        },
      },
    );
    // Root, chaos, two chaos price slices, divine, and the root recheck.
    expect(requests.search).toBe(6);
    expect(requests.ranged).toBe(2);
  });

  it.each([
    [
      'a third currency',
      mixedListings(
        listings(5, 'exalted').map((row) => ({ ...row, id: `ex-${row.id}` })),
      ),
      {},
    ],
    ['totals that do not reconcile', mixedListings(), { unsliced: 'id-150' }],
  ])('keeps mixed coverage partial with %s', async (_label, data, options) => {
    const { rateLimits, economy } = setup(data, options);
    const run = fixtureTradeCapture(rateLimits, economy, environment);
    expect(await run(target(true), new AbortController().signal)).toMatchObject(
      {
        status: 'success',
        capture: {
          complete: false,
          partialReason: 'MIXED_CURRENCY_TOTAL_MISMATCH',
        },
      },
    );
  });

  it.each([
    [180, true],
    [180, false],
    [24, true],
  ])(
    'preserves sorted starting-base prefix proof for %s asks (proof=%s)',
    async (count, proof) => {
      const { rateLimits, economy, requests } = setup(
        listings(count),
        proof ? {} : { omit: 'id-19' },
      );
      const run = fixtureTradeCapture(rateLimits, economy, environment);
      expect(
        await run(target(true, 'starting-base'), new AbortController().signal),
      ).toMatchObject({
        status: 'success',
        capture: {
          complete: count === 24,
          sortedSampleIds: proof
            ? Array.from({ length: 20 }, (_, i) => `id-${i + 1}`)
            : null,
          fetched: count === 24 ? 24 : proof ? 20 : 19,
          reportedTotal: count,
        },
      });
      expect(requests).toEqual({
        search: 1,
        ranged: 0,
        detail: count === 24 ? 3 : 2,
      });
    },
  );

  it('preserves original fractional asks with one pinned exchange snapshot', async () => {
    const exchange: StoredMarketEconomySnapshot = {
      id: exchangeId,
      schemaVersion: 1,
      kind: 'economy-overview',
      source: 'poe.ninja',
      game: 'poe1',
      league: 'Demo',
      category: 'Currency',
      endpoint: 'https://poe.ninja/demo',
      payloadHash: 'a'.repeat(64),
      capturedAt: at.toISOString(),
      sourceUpdatedAt: null,
      priceBasis: 'currency-exchange',
      raw: {},
      lines: [
        {
          id: 'divine',
          name: 'Divine Orb',
          detailsId: 'divine-orb',
          baseType: null,
          price: { amount: 200, currency: 'chaos' },
          listingCount: null,
          observationCount: 10,
          tradedVolume: null,
        },
      ],
    };
    const data = listings(24, 'divine');
    const first = data[0];
    if (!first) throw new Error('Test data is empty');
    first.listing.price.amount = 2.5;
    const { rateLimits, economy, find } = setup(data, { exchange });
    const run = fixtureTradeCapture(rateLimits, economy, environment);
    const result = await run(target(true), new AbortController().signal);
    expect(result).toMatchObject({
      status: 'success',
      capture: {
        complete: true,
        fxSnapshotId: exchangeId,
        listings: expect.arrayContaining([
          expect.objectContaining({
            itemId: 'id-1',
            seller: 'seller-0',
            fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
            indexedAt: at,
            price: { amount: '2.5', currency: 'divine' },
            priceChaos: '500',
          }),
        ]),
      },
    });
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('defers an observed and retained 429 without reissuing the request', async () => {
    const { rateLimits, economy, requests, now } = setup([], { status: 429 });
    const run = fixtureTradeCapture(rateLimits, economy, environment);
    const signal = new AbortController().signal;
    const first = await run(target(), signal);
    expect(first).toMatchObject({
      status: 'retry',
      reason: 'PROVIDER_RATE_LIMITED',
      retryAt: new Date(at.getTime() + 120_000),
    });
    expect(await run(target(), signal)).toEqual(first);
    expect(requests.search).toBe(1);
    expect(now()).toEqual(at);
  });

  it('preserves Retry-After from HTTP 503', async () => {
    const { rateLimits, economy, requests } = setup([], { status: 503 });
    const run = fixtureTradeCapture(rateLimits, economy, environment);
    expect(await run(target(), new AbortController().signal)).toEqual({
      status: 'retry',
      reason: 'PROVIDER_UNAVAILABLE',
      retryAt: new Date(at.getTime() + 120_000),
    });
    expect(requests.search).toBe(1);
  });

  it('uses structured modifier identity and requires observed modifiers for fingerprints', async () => {
    const data = listings(3);
    const [first, second, empty] = data;
    if (!first || !second || !empty) throw new Error('Fixture rows missing');
    const modifier = (hash: string) => ({
      description: '+90 to maximum Life',
      domain: 'explicit',
      hash,
      mods: [{ tier: 'P2' }],
    });
    Object.assign(first.item, { explicitMods: [modifier('stat_1')] });
    Object.assign(second.item, { explicitMods: [modifier('stat_2')] });
    Object.assign(empty.item, { explicitMods: [], verified: true });
    const { rateLimits, economy } = setup(data);
    const result = await fixtureTradeCapture(
      rateLimits,
      economy,
      environment,
    )(target(), new AbortController().signal);
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('Capture failed');
    const fingerprints = result.capture.listings.map(
      ({ fingerprint }) => fingerprint,
    );
    expect(fingerprints).toEqual([
      expect.any(String),
      expect.any(String),
      null,
    ]);
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
  });

  it('reports authentication denial after one request', async () => {
    const { rateLimits, economy, requests } = setup([], { status: 401 });
    const run = fixtureTradeCapture(rateLimits, economy, environment);
    expect(await run(target(), new AbortController().signal)).toEqual({
      status: 'blocked',
      reason: 'PROVIDER_AUTH_FAILED',
    });
    expect(requests.search).toBe(1);
  });

  it('never contacts Trade without explicit owner permission', async () => {
    const { rateLimits, economy, requests } = setup([]);
    const run = configuredTradeCapture(rateLimits, economy, {});
    expect(await run(target(), new AbortController().signal)).toEqual({
      status: 'blocked',
      reason: 'MARKET_ACCESS_BLOCKED',
    });
    expect(requests.search).toBe(0);
  });
});

function fixtureTradeCapture(
  ...args: Parameters<typeof configuredTradeCapture>
) {
  const run = configuredTradeCapture(...args);
  const { sessions } = sessionStorage();
  return (schedule: Parameters<typeof run>[0], signal: AbortSignal) =>
    run(schedule, signal, { sessions: () => sessions });
}

function loginBrowser(
  options: {
    throttle?: 'goto' | 'submit';
    onNavigation?: () => void;
    status?: number;
  } = {},
) {
  let responseListener: ((response: BrowserResponse) => void) | undefined;
  const throttle = () =>
    responseListener?.({
      status: () => options.status ?? 429,
      url: () => 'https://www.pathofexile.com/login',
      request: () => ({
        url: () => 'https://www.pathofexile.com/login',
        isNavigationRequest: () => true,
      }),
      headers: () => (options.status === 503 ? {} : { 'retry-after': '120' }),
    } as unknown as BrowserResponse);
  let loggedIn = false;
  const locator = {
    all: async () => [],
    first: () => locator,
    count: async () => 1,
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => {
      if (options.throttle === 'submit') throttle();
      else loggedIn = true;
    }),
    getByText: () => locator,
    isVisible: async () => loggedIn,
    innerText: async () => '',
  };
  const close = vi.fn(async () => undefined);
  const launch = vi
    .spyOn(chromium, 'launchPersistentContext')
    .mockResolvedValue({
      clearCookies: async () => undefined,
      pages: () => [
        {
          goto: async () => {
            if (options.throttle === 'goto') throttle();
            options.onNavigation?.();
          },
          on: (event: string, listener: typeof responseListener) => {
            if (event === 'response') responseListener = listener;
          },
          off: (event: string) => {
            if (event === 'response') responseListener = undefined;
          },
          url: () => 'https://www.pathofexile.com/login',
          title: async () => 'Login',
          locator: () => locator,
        },
      ],
      cookies: async () =>
        loggedIn ? [{ name: 'POESESSID', value: 'new-test-session' }] : [],
      close,
    } as unknown as BrowserContext);
  return { launch, close, fill: locator.fill, click: locator.click };
}

function sessionStorage() {
  let sealed: string | undefined;
  const query = vi.fn(async (sql: string, values?: string[]) => {
    if (sql.startsWith('insert')) sealed = values?.[0];
    return { rows: sealed ? [{ sealed_session: sealed }] : [] };
  });
  const sessions = createTradeSessionRepository(
    { query } as unknown as Pick<Pool, 'query'>,
    '12'.repeat(32),
  );
  return { sessions, sealed: () => sealed };
}

const loginEnvironment = {
  ...environment,
  POE_TRADE_USERNAME: 'fake-user',
  POE_TRADE_PASSWORD: 'fake-password',
  POE_TRADE_BROWSER_PROFILE_DIR: 'fake-profile',
};

describe('collector Trade session recovery', () => {
  it.each([
    { credentials: 'complete', login: loginEnvironment },
    {
      credentials: 'incomplete',
      login: { ...loginEnvironment, POE_TRADE_PASSWORD: undefined },
    },
  ])(
    'reuses the sealed session with $credentials browser credentials',
    async ({ login }) => {
      const { rateLimits, economy } = setup([]);
      const { launch } = loginBrowser();
      const { sessions } = sessionStorage();
      await sessions.save('stored-test-session');
      const fetch = vi.mocked(globalThis.fetch);
      const run = configuredTradeCapture(rateLimits, economy, login);
      expect(
        await run(target(), new AbortController().signal, {
          sessions: () => sessions,
        }),
      ).toMatchObject({ status: 'success' });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('cookie')).toBe(
        'POESESSID=stored-test-session',
      );
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: 401, headers: {} },
    { status: 403, headers: {} },
    { status: 503, headers: { 'cf-mitigated': 'challenge' } },
  ])(
    'refreshes once after $status and retries through the gate with the sealed replacement',
    async ({ status, headers }) => {
      const { rateLimits, economy } = setup([]);
      const { launch, close } = loginBrowser();
      const { sessions, sealed } = sessionStorage();
      await sessions.save('old-test-session');
      const oldSealed = sealed();
      const gate = vi.spyOn(rateLimits, 'waitForPermit');
      const fetch = vi.mocked(globalThis.fetch);
      fetch.mockResolvedValueOnce(
        new Response(null, {
          status,
          headers: new Headers(headers as Record<string, string>),
        }),
      );
      fetch.mockImplementationOnce(async () => {
        expect(await sessions.read()).toBe('new-test-session');
        return Response.json({ id: 'retried', result: [], total: 0 });
      });
      const run = configuredTradeCapture(rateLimits, economy, loginEnvironment);
      expect(
        await run(target(), new AbortController().signal, {
          sessions: () => sessions,
        }),
      ).toMatchObject({ status: 'success' });
      expect(gate).toHaveBeenCalledTimes(3);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('cookie')).toBe(
        'POESESSID=old-test-session',
      );
      expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('cookie')).toBe(
        'POESESSID=new-test-session',
      );
      expect(launch).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(sealed()).not.toEqual(oldSealed);
      expect(sealed()).not.toContain('new-test-session');
    },
  );

  it('blocks after the retried request is denied and leaves a legacy denial intact', async () => {
    const { rateLimits, economy, repository } = setup([]);
    const { launch } = loginBrowser();
    const { sessions } = sessionStorage();
    await rateLimits.observeResponse('trade-fetch', {
      status: 403,
      headers: new Headers(),
    });
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockImplementation(async () => new Response(null, { status: 401 }));
    const run = configuredTradeCapture(rateLimits, economy, loginEnvironment);
    expect(
      await run(target(), new AbortController().signal, {
        sessions: () => sessions,
      }),
    ).toEqual({ status: 'blocked', reason: 'PROVIDER_AUTH_FAILED' });
    expect(launch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await repository.list()).toMatchObject([{ lastStatus: 403 }]);
    await expect(
      rateLimits.waitForPermit('trade-search'),
    ).rejects.toMatchObject({ code: 'MARKET_ACCESS_BLOCKED' });
  });

  it('stops after one request when sealing fails', async () => {
    const { rateLimits, economy } = setup([]);
    const { launch } = loginBrowser();
    const { sessions } = sessionStorage();
    vi.spyOn(sessions, 'save').mockRejectedValue(
      new Error('session store unavailable'),
    );
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const run = configuredTradeCapture(rateLimits, economy, loginEnvironment);
    expect(
      await run(target(), new AbortController().signal, {
        sessions: () => sessions,
      }),
    ).toEqual({ status: 'blocked', reason: 'PROVIDER_AUTH_FAILED' });
    expect(launch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('uses the newly sealed session on the first request of an explicit recovery', async () => {
    const { rateLimits, economy } = setup([]);
    const { launch } = loginBrowser();
    const { sessions } = sessionStorage();
    await sessions.save('denied-test-session');
    const fetch = vi.mocked(globalThis.fetch);
    const run = configuredTradeCapture(rateLimits, economy, loginEnvironment);
    expect(
      await run(target(), new AbortController().signal, {
        sessions: () => sessions,
        recoverAuthentication: true,
      }),
    ).toMatchObject({ status: 'success' });
    expect(launch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('cookie')).toBe(
      'POESESSID=new-test-session',
    );
    expect(await sessions.read()).toBe('new-test-session');
  });

  it('blocks when the sealing key is missing, without provider traffic', async () => {
    const { rateLimits, economy, requests } = setup([]);
    const { launch } = loginBrowser();
    const run = configuredTradeCapture(rateLimits, economy, loginEnvironment);
    expect(await run(target(), new AbortController().signal)).toEqual({
      status: 'blocked',
      reason: 'TRADE_SESSION_KEY_INVALID',
    });
    expect(launch).not.toHaveBeenCalled();
    expect(requests.search).toBe(0);
  });

  it('distinguishes a transient read error from a corrupt session that Run now can replace', async () => {
    const { rateLimits, economy, requests } = setup([]);
    const { launch } = loginBrowser();
    const { sessions } = sessionStorage();
    vi.spyOn(sessions, 'read')
      .mockRejectedValueOnce(new Error('query failed'))
      .mockRejectedValueOnce(new TradeSessionDecryptError());
    const run = configuredTradeCapture(rateLimits, economy, loginEnvironment);
    const signal = new AbortController().signal;
    const storage = { sessions: () => sessions };
    expect(await run(target(), signal, storage)).toEqual({
      status: 'retry',
      reason: 'TRADE_SESSION_UNAVAILABLE',
    });
    expect(await run(target(), signal, storage)).toEqual({
      status: 'blocked',
      reason: 'TRADE_SESSION_DECRYPT_FAILED',
    });
    expect(launch).not.toHaveBeenCalled();
    expect(requests.search).toBe(0);
    expect(
      await run(target(), signal, { ...storage, recoverAuthentication: true }),
    ).toMatchObject({ status: 'success' });
    expect(launch).toHaveBeenCalledOnce();
    expect(await sessions.read()).toBe('new-test-session');
  });

  it('aborts browser recovery before submitting credentials after losing the lease', async () => {
    const { rateLimits, economy } = setup([]);
    const job = new AbortController();
    const { fill, click, close } = loginBrowser({
      onNavigation: () => job.abort(),
    });
    const { sessions } = sessionStorage();
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const run = configuredTradeCapture(rateLimits, economy, loginEnvironment);
    await expect(
      run(target(), job.signal, { sessions: () => sessions }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fill).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(await sessions.read()).toBeNull();
  });

  it.each(['goto', 'submit'] as const)(
    'retains Retry-After on a login %s response',
    async (throttle) => {
      const { rateLimits, economy, repository } = setup([]);
      const { launch, close } = loginBrowser({ throttle });
      const { sessions } = sessionStorage();
      const fetch = vi.mocked(globalThis.fetch);
      fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
      const run = configuredTradeCapture(rateLimits, economy, loginEnvironment);
      const result = await run(target(), new AbortController().signal, {
        sessions: () => sessions,
      });
      expect(result).toEqual({
        status: 'retry',
        reason: 'PROVIDER_RATE_LIMITED',
        retryAt: new Date(at.getTime() + 121_000),
      });
      expect(await repository.list()).toMatchObject([{ lastStatus: 429 }]);
      expect(launch).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
      expect(await sessions.read()).toBeNull();
    },
  );

  it('honors a raw 429 with a challenge header and blocks manual login during the cooldown', async () => {
    const { rateLimits, economy, repository } = setup([]);
    const { launch } = loginBrowser();
    const { sessions } = sessionStorage();
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 429,
        headers: { 'cf-mitigated': 'challenge', 'Retry-After': '120' },
      }),
    );
    const run = configuredTradeCapture(rateLimits, economy, loginEnvironment);
    const signal = new AbortController().signal;
    const retry = {
      status: 'retry',
      reason: 'PROVIDER_RATE_LIMITED',
      retryAt: new Date(at.getTime() + 120_000),
    };
    expect(await run(target(), signal, { sessions: () => sessions })).toEqual(
      retry,
    );
    expect(
      await run(target(), signal, {
        sessions: () => sessions,
        recoverAuthentication: true,
      }),
    ).toEqual(retry);
    expect(await repository.list()).toMatchObject([{ lastStatus: 429 }]);
    expect(launch).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });
});

it('observes restrictive Trade headers before rejecting a malformed successful body', async () => {
  const { rateLimits, economy, repository } = setup([]);
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(
    new Response('invalid JSON', {
      status: 200,
      headers: {
        'x-rate-limit-policy': 'trade-search-request-limit',
        'x-rate-limit-rules': 'ip',
        'x-rate-limit-ip': '3:60:120',
        'x-rate-limit-ip-state': '3:60:90',
      },
    }),
  );
  const run = fixtureTradeCapture(rateLimits, economy, environment);
  expect(await run(target(), new AbortController().signal)).toMatchObject({
    status: 'retry',
    reason: 'PROVIDER_RESPONSE_INVALID',
  });
  expect(await repository.list()).toMatchObject([
    {
      lastStatus: 200,
      windows: [
        {
          rule: 'ip',
          maximumHits: 3,
          currentHits: 3,
          activeRestrictionSeconds: 90,
        },
      ],
    },
  ]);
});

it('backs off a temporary login 503 instead of making it an auth block', async () => {
  const { rateLimits, economy } = setup([]);
  const { close } = loginBrowser({ throttle: 'goto', status: 503 });
  const { sessions } = sessionStorage();
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(
    new Response(null, { status: 401 }),
  );
  const run = configuredTradeCapture(
    rateLimits,
    economy,
    loginEnvironment,
    new CollectorTelemetry(),
  );
  expect(
    await run(target(), new AbortController().signal, {
      sessions: () => sessions,
    }),
  ).toMatchObject({
    status: 'retry',
    reason: 'PROVIDER_UNAVAILABLE',
  });
  expect(close).toHaveBeenCalledOnce();
});
