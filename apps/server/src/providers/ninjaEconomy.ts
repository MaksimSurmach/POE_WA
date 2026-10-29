import { createHash } from 'node:crypto';
import { z } from 'zod';

// Only the public economy surface documented at https://poe.ninja/docs/api.
// These aggregates are not comparable rare-item listings or completed gear sales.
export const ninjaEconomyCategories = [
  'BaseType',
  'Currency',
  'Essence',
  'Fossil',
  'Resonator',
] as const;
export type NinjaEconomyCategory = (typeof ninjaEconomyCategories)[number];
export type NinjaJson =
  | null
  | boolean
  | number
  | string
  | readonly NinjaJson[]
  | { readonly [key: string]: NinjaJson };
export type NinjaEconomyFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type NinjaEconomyLine = Readonly<{
  id: string;
  name: string | null;
  detailsId: string | null;
  baseType: string | null;
  price: Readonly<{ amount: number | null; currency: string }>;
  listingCount: number | null;
  observationCount: number | null;
  tradedVolume: Readonly<{ amount: number; currency: string }> | null;
}>;

type Evidence = Readonly<{
  schemaVersion: 1;
  source: 'poe.ninja';
  game: 'poe1';
  endpoint: string;
  payloadHash: string;
  // First receipt of this body; an HTTP 304 must not make old data look newer.
  capturedAt: string;
  // The overview contract does not supply a trustworthy source timestamp.
  sourceUpdatedAt: null;
  raw: NinjaJson;
}>;

export type NinjaEconomySnapshot = Evidence &
  Readonly<{
    kind: 'economy-overview';
    league: string;
    category: NinjaEconomyCategory;
    priceBasis: 'stash-estimate' | 'currency-exchange';
    lines: readonly NinjaEconomyLine[];
  }>;
export type NinjaLeagueSnapshot = Evidence &
  Readonly<{
    kind: 'league-list';
    leagues: readonly Readonly<{ id: string; name: string }>[];
  }>;
export type NinjaReadResult<T> = Readonly<{
  snapshot: T;
  cacheStatus: 'fetched' | 'hit' | 'revalidated';
  // Last successful HTTP check, not the time a cache hit was requested.
  checkedAt: string;
  nextRefreshAt: string;
  archiveAllowed: boolean;
}>;
export type NinjaEconomyErrorCode =
  | 'INVALID_REQUEST'
  | 'BUSY'
  | 'COOLDOWN'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'HTTP_ERROR'
  | 'SCHEMA_INVALID';

export class NinjaEconomyError extends Error {
  readonly code: NinjaEconomyErrorCode;
  readonly status: number | null;
  readonly retryAt: string | null;

  constructor(
    code: NinjaEconomyErrorCode,
    message: string,
    options: { status?: number; retryAt?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'NinjaEconomyError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryAt =
      options.retryAt === undefined
        ? null
        : new Date(options.retryAt).toISOString();
  }
}

const text = z.string().min(1);
const amount = z.number().finite().nonnegative();
const count = z.number().int().nonnegative().nullish();
const leaguesSchema = z.array(z.object({ id: text, name: text })).max(100);
const itemSchema = z.object({
  lines: z
    .array(
      z.object({
        id: z.number().int().nonnegative(),
        name: text,
        detailsId: text,
        baseType: text.nullish(),
        chaosValue: amount.nullish(),
        count,
        listingCount: count,
      }),
    )
    .max(100_000),
});
const metadataSchema = z.object({
  id: text,
  name: text,
  detailsId: text.nullish(),
});
const exchangeSchema = z.object({
  core: z.object({
    primary: text,
    items: z.array(metadataSchema).max(100_000).optional(),
  }),
  items: z.array(metadataSchema).max(100_000).optional(),
  lines: z
    .array(
      z.object({
        id: text,
        primaryValue: amount.nullish(),
        volumePrimaryValue: amount.nullish(),
      }),
    )
    .max(100_000),
});

type Snapshot = NinjaEconomySnapshot | NinjaLeagueSnapshot;
type CacheEntry = {
  snapshot: Snapshot | null;
  etag: string | null;
  checkedAt: number;
  expiresAt: number;
  nextRequestAt: number;
  maxAgeMs: number;
  noStore: boolean;
};

export class NinjaEconomyClient {
  readonly #fetch: NinjaEconomyFetch;
  readonly #now: () => Date;
  readonly #userAgent: string;
  readonly #minRefreshMs: number;
  readonly #maxCacheEntries: number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, Promise<NinjaReadResult<Snapshot>>>();
  #cooldownUntil = 0;

  constructor(options: {
    userAgent: string;
    fetch?: NinjaEconomyFetch;
    now?: () => Date;
    minRefreshMs?: number;
    maxCacheEntries?: number;
  }) {
    this.#userAgent = options.userAgent.trim();
    if (!this.#userAgent || /[\r\n]/u.test(this.#userAgent)) {
      throw new TypeError('A descriptive userAgent with contact is required');
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#minRefreshMs = options.minRefreshMs ?? 5 * 60_000;
    this.#maxCacheEntries = options.maxCacheEntries ?? 32;
    for (const value of [this.#minRefreshMs, this.#maxCacheEntries]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError('Cache limits must be positive safe integers');
      }
    }
  }

  async discoverLeagues(): Promise<NinjaReadResult<NinjaLeagueSnapshot>> {
    const result = await this.#read(
      new URL('https://poe.ninja/poe1/api/economy/leagues'),
      (raw, evidence) => ({
        ...evidence,
        kind: 'league-list',
        leagues: parse(leaguesSchema, raw),
      }),
    );
    if (result.snapshot.kind !== 'league-list') {
      throw new Error('Cache mismatch');
    }
    return Object.freeze({ ...result, snapshot: result.snapshot });
  }

  async fetchSnapshot(request: {
    league: string;
    category: NinjaEconomyCategory;
  }): Promise<NinjaReadResult<NinjaEconomySnapshot>> {
    const league = request.league.trim();
    if (
      !league ||
      league.length > 100 ||
      [...league].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) ||
      !ninjaEconomyCategories.includes(request.category)
    ) {
      throw new NinjaEconomyError(
        'INVALID_REQUEST',
        'Invalid league or category',
      );
    }
    const isBase = request.category === 'BaseType';
    const url = new URL(
      isBase
        ? 'https://poe.ninja/poe1/api/economy/stash/current/item/overview'
        : 'https://poe.ninja/poe1/api/economy/exchange/current/overview',
    );
    url.searchParams.set('league', league);
    url.searchParams.set('type', request.category);
    const result = await this.#read(url, (raw, evidence) => ({
      ...evidence,
      kind: 'economy-overview',
      league,
      category: request.category,
      priceBasis: isBase ? 'stash-estimate' : 'currency-exchange',
      lines: normalizeLines(raw, isBase),
    }));
    if (result.snapshot.kind !== 'economy-overview') {
      throw new Error('Cache mismatch');
    }
    return Object.freeze({ ...result, snapshot: result.snapshot });
  }

  async #read(
    url: URL,
    build: (raw: unknown, evidence: Evidence) => Snapshot,
  ): Promise<NinjaReadResult<Snapshot>> {
    const key = url.href;
    const now = this.#now().getTime();
    const cached = this.#cache.get(key);
    if (cached?.snapshot && now < cached.expiresAt) {
      this.#remember(key, cached);
      return resultFor(cached, 'hit');
    }
    const pending = this.#inFlight.get(key);
    if (pending) return pending;
    if (now < this.#cooldownUntil) {
      throw new NinjaEconomyError('RATE_LIMITED', 'poe.ninja is cooling down', {
        retryAt: this.#cooldownUntil,
      });
    }
    if (cached && now < cached.nextRequestAt) {
      throw new NinjaEconomyError(
        'COOLDOWN',
        'Minimum refresh interval applies',
        { retryAt: cached.nextRequestAt },
      );
    }
    // Same-key calls coalesce; distinct calls have a fixed concurrency bound.
    // Fail fast instead of building an unbounded request queue.
    if (this.#inFlight.size >= 2) {
      throw new NinjaEconomyError(
        'BUSY',
        'Two economy requests are already running',
      );
    }
    const entry: CacheEntry = {
      snapshot: cached?.snapshot ?? null,
      etag: cached?.etag ?? null,
      checkedAt: cached?.checkedAt ?? now,
      expiresAt: cached?.expiresAt ?? 0,
      nextRequestAt: now + this.#minRefreshMs,
      maxAgeMs: cached?.maxAgeMs ?? 15 * 60_000,
      noStore: false,
    };
    this.#remember(key, entry);
    const promise = this.#fetchDocument(url, entry, build).finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, promise);
    return promise;
  }

  async #fetchDocument(
    url: URL,
    previous: CacheEntry,
    build: (raw: unknown, evidence: Evidence) => Snapshot,
  ): Promise<NinjaReadResult<Snapshot>> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: 'application/json',
          'User-Agent': this.#userAgent,
          ...(previous.etag ? { 'If-None-Match': previous.etag } : {}),
        },
      });
    } catch (cause) {
      throw new NinjaEconomyError('UNAVAILABLE', 'Economy request failed', {
        cause,
      });
    }
    const checkedAt = this.#now().getTime();
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      this.#cooldownUntil = Math.max(
        this.#cooldownUntil,
        retryAfter(response.headers.get('retry-after'), checkedAt),
      );
      throw new NinjaEconomyError(
        'RATE_LIMITED',
        'poe.ninja rate limit reached',
        { status: 429, retryAt: this.#cooldownUntil },
      );
    }
    if (response.status !== 304 && !response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const wait = retryAfter(response.headers.get('retry-after'), checkedAt);
      previous.nextRequestAt = Math.max(previous.nextRequestAt, wait);
      throw new NinjaEconomyError(
        response.status >= 500 ? 'UNAVAILABLE' : 'HTTP_ERROR',
        'Economy endpoint returned an error',
        { status: response.status, retryAt: previous.nextRequestAt },
      );
    }

    let snapshot: Snapshot;
    if (response.status === 304) {
      if (!previous.snapshot || !previous.etag) {
        throw new NinjaEconomyError(
          'SCHEMA_INVALID',
          '304 without a cached body',
        );
      }
      snapshot = previous.snapshot;
    } else {
      const body = await readBody(response);
      let raw: unknown;
      try {
        raw = JSON.parse(body) as unknown;
      } catch (cause) {
        throw new NinjaEconomyError(
          'SCHEMA_INVALID',
          'Expected a JSON economy payload',
          { cause },
        );
      }
      const payloadHash = createHash('sha256').update(body).digest('hex');
      snapshot = freezeDeep(
        build(raw, {
          schemaVersion: 1,
          source: 'poe.ninja',
          game: 'poe1',
          endpoint: url.href,
          payloadHash,
          capturedAt: new Date(checkedAt).toISOString(),
          sourceUpdatedAt: null,
          raw: raw as NinjaJson,
        }),
      );
      const priorSnapshot = previous.snapshot;
      if (priorSnapshot && priorSnapshot.payloadHash === payloadHash) {
        snapshot = priorSnapshot;
      }
    }
    const policy = cachePolicy(response.headers, previous.maxAgeMs);
    const entry: CacheEntry = {
      snapshot: policy.noStore ? null : snapshot,
      etag: policy.noStore
        ? null
        : (response.headers.get('etag') ??
          (response.status === 304 ? previous.etag : null)),
      checkedAt,
      expiresAt: checkedAt + policy.remainingMs,
      nextRequestAt: checkedAt + this.#minRefreshMs,
      maxAgeMs: policy.maxAgeMs,
      noStore: policy.noStore,
    };
    this.#remember(url.href, entry);
    // A no-store response can be returned to this caller, but is not retained.
    return resultFor(
      { ...entry, snapshot },
      response.status === 304 ? 'revalidated' : 'fetched',
    );
  }

  #remember(key: string, entry: CacheEntry) {
    this.#cache.delete(key);
    this.#cache.set(key, entry);
    while (this.#cache.size > this.#maxCacheEntries) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}

function normalizeLines(raw: unknown, isBase: boolean): NinjaEconomyLine[] {
  if (isBase) {
    return parse(itemSchema, raw).lines.map((line) => ({
      id: String(line.id),
      name: line.name,
      detailsId: line.detailsId,
      baseType: line.baseType ?? null,
      price: { amount: positiveOrNull(line.chaosValue), currency: 'chaos' },
      listingCount: line.listingCount ?? null,
      observationCount: line.count ?? null,
      tradedVolume: null,
    }));
  }
  const data = parse(exchangeSchema, raw);
  const metadata = new Map(
    [...(data.core.items ?? []), ...(data.items ?? [])].map((item) => [
      item.id,
      item,
    ]),
  );
  return data.lines.map((line) => ({
    id: line.id,
    name: metadata.get(line.id)?.name ?? null,
    detailsId: metadata.get(line.id)?.detailsId ?? null,
    baseType: null,
    price: {
      amount: positiveOrNull(line.primaryValue),
      currency: data.core.primary,
    },
    listingCount: null,
    observationCount: null,
    tradedVolume:
      line.volumePrimaryValue == null
        ? null
        : { amount: line.volumePrimaryValue, currency: data.core.primary },
  }));
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new NinjaEconomyError(
      'SCHEMA_INVALID',
      'Economy payload schema changed',
      { cause: result.error },
    );
  }
  return result.data;
}

function positiveOrNull(value: number | null | undefined) {
  return value != null && value > 0 ? value : null;
}

function resultFor(
  entry: CacheEntry,
  cacheStatus: NinjaReadResult<Snapshot>['cacheStatus'],
): NinjaReadResult<Snapshot> {
  if (!entry.snapshot) throw new Error('Cache entry has no snapshot');
  return Object.freeze({
    snapshot: entry.snapshot,
    cacheStatus,
    checkedAt: new Date(entry.checkedAt).toISOString(),
    archiveAllowed: !entry.noStore,
    nextRefreshAt: new Date(
      Math.max(entry.expiresAt, entry.nextRequestAt),
    ).toISOString(),
  });
}

function cachePolicy(headers: Headers, fallbackMs: number) {
  const control = headers.get('cache-control') ?? '';
  const match = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/iu.exec(control);
  const seconds = match?.[1] === undefined ? null : Number(match[1]);
  const maxAgeMs =
    seconds != null && Number.isSafeInteger(seconds)
      ? Math.min(seconds * 1000, 365 * 24 * 60 * 60_000)
      : fallbackMs;
  const age = Number(headers.get('age') ?? 0);
  const ageMs = Number.isFinite(age) && age >= 0 ? age * 1000 : 0;
  const noStore = /(?:^|,)\s*no-store(?:,|$)/iu.test(control);
  const noCache = /(?:^|,)\s*no-cache(?:[,=]|$)/iu.test(control);
  return {
    maxAgeMs,
    noStore,
    remainingMs: noStore || noCache ? 0 : Math.max(0, maxAgeMs - ageMs),
  };
}

function retryAfter(header: string | null, now: number) {
  if (header !== null) {
    const value = header.trim();
    const parsed = /^\d+(?:\.\d+)?$/u.test(value)
      ? now + Math.ceil(Number(value) * 1000)
      : Date.parse(value);
    if (Number.isFinite(parsed) && parsed > now && parsed <= 8.64e15) {
      return parsed;
    }
  }
  return now + 60_000;
}

async function readBody(response: Response) {
  const maxBytes = 16 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new NinjaEconomyError(
      'SCHEMA_INVALID',
      'Economy payload exceeds size limit',
    );
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new NinjaEconomyError('SCHEMA_INVALID', 'Empty response body');
  }
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new NinjaEconomyError(
          'SCHEMA_INVALID',
          'Economy payload exceeds size limit',
        );
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } catch (cause) {
    if (cause instanceof NinjaEconomyError) throw cause;
    throw new NinjaEconomyError(
      'UNAVAILABLE',
      'Economy response was interrupted',
      { cause },
    );
  } finally {
    reader.releaseLock();
  }
}

function freezeDeep<T>(value: T): T {
  // Avoid recursion on unexpectedly deeply nested, size-bounded JSON bodies.
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      current !== null &&
      typeof current === 'object' &&
      !Object.isFrozen(current)
    ) {
      for (const child of Object.values(current)) pending.push(child);
      Object.freeze(current);
    }
  }
  return value;
}
