import { describe, expect, it, vi } from 'vitest';

import {
  NinjaEconomyClient,
  NinjaEconomyError,
  type NinjaEconomyFetch,
} from './ninjaEconomy.js';

// Synthetic contract fixtures, never a claim about current league prices.
const bases = {
  lines: [
    {
      id: 12,
      name: 'Example Belt',
      baseType: 'Example Belt',
      detailsId: 'example-belt-85',
      chaosValue: 20,
      listingCount: 6,
      count: 9,
      variant: '85',
    },
  ],
};
const exchange = {
  core: { primary: 'divine', items: [{ id: 'chaos', name: 'Chaos Orb' }] },
  items: [
    { id: 'essence', name: 'Example Essence', detailsId: 'example-essence' },
  ],
  lines: [{ id: 'essence', primaryValue: 0.02, volumePrimaryValue: 50 }],
};
const request = { league: 'Example League', category: 'BaseType' } as const;
const userAgent = 'poe-worksmith-test/0.1 (contact: test@example.com)';

function clock() {
  let milliseconds = Date.parse('2026-10-01T00:00:00.000Z');
  return {
    now: () => new Date(milliseconds),
    advance: (amount: number) => {
      milliseconds += amount;
    },
  };
}

describe('public Ninja economy connector', () => {
  it('discovers leagues and distinguishes aggregate price meanings', async () => {
    const fetch = vi.fn<NinjaEconomyFetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/leagues')) {
        return Response.json([
          { id: 'Available League', name: 'Available League' },
        ]);
      }
      return Response.json(url.includes('/exchange/') ? exchange : bases);
    });
    const client = new NinjaEconomyClient({ fetch, userAgent });
    const leagues = await client.discoverLeagues();
    const base = await client.fetchSnapshot(request);
    const essence = await client.fetchSnapshot({
      league: 'Explicit Other League',
      category: 'Essence',
    });

    expect(leagues.snapshot.leagues).toEqual([
      { id: 'Available League', name: 'Available League' },
    ]);
    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      'https://poe.ninja/poe1/api/economy/stash/current/item/overview?league=Example+League&type=BaseType',
    );
    expect(String(fetch.mock.calls[2]?.[0])).toBe(
      'https://poe.ninja/poe1/api/economy/exchange/current/overview?league=Explicit+Other+League&type=Essence',
    );
    expect(base.snapshot).toMatchObject({
      kind: 'economy-overview',
      source: 'poe.ninja',
      game: 'poe1',
      priceBasis: 'stash-estimate',
      sourceUpdatedAt: null,
      lines: [
        {
          price: { amount: 20, currency: 'chaos' },
          listingCount: 6,
          observationCount: 9,
          tradedVolume: null,
        },
      ],
    });
    expect(essence.snapshot).toMatchObject({
      priceBasis: 'currency-exchange',
      lines: [
        {
          name: 'Example Essence',
          price: { amount: 0.02, currency: 'divine' },
          listingCount: null,
          observationCount: null,
          tradedVolume: { amount: 50, currency: 'divine' },
        },
      ],
    });
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
    });
    expect(
      new Headers(fetch.mock.calls[1]?.[1]?.headers).get('User-Agent'),
    ).toBe(userAgent);
    expect(Object.isFrozen(base.snapshot.raw)).toBe(true);
    expect(Object.isFrozen(base.snapshot.lines[0]?.price)).toBe(true);
    expect(base.snapshot.raw).toEqual(bases);
  });

  it('coalesces requests and retains capture times on cache hits', async () => {
    const time = clock();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn<NinjaEconomyFetch>(async () => {
      await gate;
      return Response.json(bases, {
        headers: { 'Cache-Control': 'max-age=1200', ETag: '"v1"' },
      });
    });
    const client = new NinjaEconomyClient({ fetch, userAgent, now: time.now });
    const pending = [
      client.fetchSnapshot(request),
      client.fetchSnapshot(request),
    ];
    expect(fetch).toHaveBeenCalledTimes(1);
    release();
    const [first, concurrent] = await Promise.all(pending);
    time.advance(10 * 60_000);
    const hit = await client.fetchSnapshot(request);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(hit.cacheStatus).toBe('hit');
    expect(hit.snapshot).toBe(first?.snapshot);
    expect(concurrent?.snapshot).toBe(first?.snapshot);
    expect(hit.checkedAt).toBe(first?.checkedAt);
    expect(hit.nextRefreshAt).toBe('2026-10-01T00:20:00.000Z');
  });

  it('honors ETag and cache headers on 304 without a new snapshot', async () => {
    const time = clock();
    const fetch = vi
      .fn<NinjaEconomyFetch>()
      .mockResolvedValueOnce(
        Response.json(bases, {
          headers: { 'Cache-Control': 'max-age=300', ETag: '"v1"' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 304,
          headers: {
            'Cache-Control': 'max-age=1200',
            Age: '300',
            ETag: '"v1"',
          },
        }),
      );
    const client = new NinjaEconomyClient({ fetch, userAgent, now: time.now });
    const initial = await client.fetchSnapshot(request);
    time.advance(5 * 60_000);
    const refreshed = await client.fetchSnapshot(request);

    expect(
      new Headers(fetch.mock.calls[1]?.[1]?.headers).get('If-None-Match'),
    ).toBe('"v1"');
    expect(refreshed.cacheStatus).toBe('revalidated');
    expect(refreshed.snapshot).toBe(initial.snapshot);
    expect(refreshed.snapshot.capturedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(refreshed.checkedAt).toBe('2026-10-01T00:05:00.000Z');
    expect(refreshed.nextRefreshAt).toBe('2026-10-01T00:20:00.000Z');
    time.advance(14 * 60_000);
    expect((await client.fetchSnapshot(request)).cacheStatus).toBe('hit');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['120', 'Thu, 01 Oct 2026 00:02:00 GMT'])(
    'backs off all categories after 429 with Retry-After %s',
    async (retryHeader) => {
      const time = clock();
      const fetch = vi
        .fn<NinjaEconomyFetch>()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 429,
            headers: { 'Retry-After': retryHeader },
          }),
        )
        .mockResolvedValueOnce(Response.json(exchange));
      const client = new NinjaEconomyClient({
        fetch,
        userAgent,
        now: time.now,
        minRefreshMs: 1000,
      });
      await expect(client.fetchSnapshot(request)).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        status: 429,
        retryAt: '2026-10-01T00:02:00.000Z',
      });
      time.advance(119_000);
      await expect(
        client.fetchSnapshot({ ...request, category: 'Currency' }),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      expect(fetch).toHaveBeenCalledTimes(1);
      time.advance(1000);
      await expect(
        client.fetchSnapshot({ ...request, category: 'Currency' }),
      ).resolves.toMatchObject({ cacheStatus: 'fetched' });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('distinguishes schema failures from empty markets and recovers', async () => {
    const time = clock();
    const fetch = vi
      .fn<NinjaEconomyFetch>()
      .mockResolvedValueOnce(
        Response.json({ lines: [{ unexpected: 'payload' }] }),
      )
      .mockResolvedValueOnce(Response.json({ lines: [] }));
    const client = new NinjaEconomyClient({ fetch, userAgent, now: time.now });
    const failure = await client
      .fetchSnapshot(request)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NinjaEconomyError);
    expect(failure).toMatchObject({ code: 'SCHEMA_INVALID' });
    await expect(client.fetchSnapshot(request)).rejects.toMatchObject({
      code: 'COOLDOWN',
    });
    time.advance(5 * 60_000);
    const empty = await client.fetchSnapshot(request);
    expect(empty.snapshot.lines).toEqual([]);
    expect(empty.cacheStatus).toBe('fetched');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses unbacked 304 and HTML; missing prices stay unknown', async () => {
    for (const response of [
      new Response(null, { status: 304 }),
      new Response('<html>error</html>'),
    ]) {
      const client = new NinjaEconomyClient({
        userAgent,
        fetch: async () => response,
      });
      await expect(client.fetchSnapshot(request)).rejects.toMatchObject({
        code: 'SCHEMA_INVALID',
      });
    }
    const client = new NinjaEconomyClient({
      userAgent,
      fetch: async () =>
        Response.json({
          lines: [
            { id: 1, name: 'Unknown', detailsId: 'unknown', chaosValue: 0 },
          ],
        }),
    });
    expect(
      (await client.fetchSnapshot(request)).snapshot.lines[0],
    ).toMatchObject({
      price: { amount: null, currency: 'chaos' },
      listingCount: null,
    });
  });

  it('bounds distinct in-flight requests and cache size', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn<NinjaEconomyFetch>(async () => {
      await gate;
      return Response.json(exchange);
    });
    const client = new NinjaEconomyClient({
      fetch,
      userAgent,
      maxCacheEntries: 2,
    });
    const first = client.fetchSnapshot({ ...request, category: 'Currency' });
    const second = client.fetchSnapshot({ ...request, category: 'Essence' });
    await expect(
      client.fetchSnapshot({ ...request, category: 'Fossil' }),
    ).rejects.toMatchObject({ code: 'BUSY' });
    expect(fetch).toHaveBeenCalledTimes(2);
    release();
    await Promise.all([first, second]);
    await client.fetchSnapshot({ ...request, category: 'Fossil' });
    await client.fetchSnapshot({ ...request, category: 'Currency' });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('retains the refresh cooldown without storing no-store bodies', async () => {
    const time = clock();
    const fetch = vi.fn<NinjaEconomyFetch>(async () =>
      Response.json(bases, {
        headers: { 'Cache-Control': 'no-store', ETag: '"v1"' },
      }),
    );
    const client = new NinjaEconomyClient({ fetch, userAgent, now: time.now });
    await client.fetchSnapshot(request);
    await expect(client.fetchSnapshot(request)).rejects.toMatchObject({
      code: 'COOLDOWN',
    });
    time.advance(5 * 60_000);
    await client.fetchSnapshot(request);
    expect(
      new Headers(fetch.mock.calls[1]?.[1]?.headers).has('If-None-Match'),
    ).toBe(false);
  });
});
