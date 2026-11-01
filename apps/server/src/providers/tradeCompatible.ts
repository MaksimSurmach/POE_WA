import { z } from 'zod';
import type {
  MarketCollectionSource,
  MarketTarget,
} from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';
import type {
  MarketCollectionTransport,
  MarketCollectionTransportResponse,
} from '../marketCollection.js';
import { generateMarketTradeQuery } from '../marketTradeQuery.js';
import { tradeStatMappings } from '../tradeStatMappings.js';

const configSchema = z.object({
  POE_TRADE_BASE_URL: z.url().default('https://www.pathofexile.com'),
  POE_TRADE_USER_AGENT: z
    .string()
    .min(8)
    .max(300)
    .regex(/^[^\r\n]+$/),
  POE_TRADE_SESSION_ID: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  POE_TRADE_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(30_000)
    .default(10_000),
});
export type TradeCompatibleConfig = {
  baseURL: string;
  userAgent: string;
  sessionId?: string;
  timeoutMs: number;
};

export function loadTradeCompatibleConfig(
  environment: Record<string, string | undefined> = process.env,
): TradeCompatibleConfig {
  const parsed = configSchema.safeParse(environment);
  // Never include Zod input/cause: it may contain a session credential.
  if (!parsed.success)
    throw new Error(
      'Invalid Trade environment: check URL, user agent, timeout and session format',
    );
  const base = new URL(parsed.data.POE_TRADE_BASE_URL);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw new Error(
      'POE_TRADE_BASE_URL must be an HTTPS origin without credentials',
    );
  return {
    baseURL: base.origin,
    userAgent: parsed.data.POE_TRADE_USER_AGENT,
    timeoutMs: parsed.data.POE_TRADE_REQUEST_TIMEOUT_MS,
    ...(parsed.data.POE_TRADE_SESSION_ID
      ? { sessionId: parsed.data.POE_TRADE_SESSION_ID }
      : {}),
  };
}

const identifier = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .max(256);
const searchSchema = z.object({
  id: identifier,
  result: z.array(identifier).max(100_000),
  total: z.number().int().nonnegative(),
  inexact: z.boolean().optional(),
});
const itemSchema = z
  .object({
    baseType: z.string().optional(),
    typeLine: z.string().optional(),
    league: z.string().optional(),
    rarity: z.string().optional(),
    frameType: z.number().int().optional(),
    ilvl: z.number().int().optional(),
    corrupted: z.boolean().optional(),
    fractured: z.boolean().optional(),
    influences: z.record(z.string(), z.boolean()).optional(),
    explicitMods: z.array(z.string()).optional(),
    implicitMods: z.array(z.string()).optional(),
    craftedMods: z.array(z.string()).optional(),
    fracturedMods: z.array(z.string()).optional(),
    properties: z
      .array(
        z.object({
          type: z.number().optional(),
          values: z.array(z.tuple([z.string(), z.number()])),
        }),
      )
      .optional(),
    extended: z
      .object({
        hashes: z
          .record(
            z.string(),
            z.array(
              z.tuple([z.string(), z.array(z.number().int().nonnegative())]),
            ),
          )
          .optional(),
        mods: z
          .record(
            z.string(),
            z.array(z.object({ tier: z.string().optional() })),
          )
          .optional(),
      })
      .optional(),
  })
  .passthrough();
const listingSchema = z
  .object({
    id: identifier,
    listing: z
      .object({
        indexed: z.iso.datetime().optional(),
        account: z.object({ name: z.string().min(1) }),
        price: z
          .object({
            amount: z.number().finite().positive().max(1e9),
            currency: z.string().min(1),
          })
          .optional(),
        fee: z.number().finite().optional(),
      })
      .passthrough(),
    item: itemSchema,
  })
  .passthrough();
const fetchSchema = z.object({
  result: z.array(listingSchema.nullable()).max(10),
});
const jsonRecord = z.record(z.string(), z.json());

function normalizedMods(item: z.infer<typeof itemSchema>) {
  const mods: Array<{ id: string; value: number; tier?: number }> = [];
  for (const origin of [
    'explicit',
    'implicit',
    'crafted',
    'fractured',
  ] as const) {
    const lines = item[`${origin}Mods`];
    if (!lines) continue;
    for (const [id, mapping] of Object.entries(tradeStatMappings)) {
      if (!id.startsWith(`${origin}.`)) continue;
      const pattern =
        '^' +
        mapping.text
          .split('#')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('(-?\\d+(?:\\.\\d+)?)') +
        '$';
      for (const line of lines) {
        const match = new RegExp(pattern).exec(line);
        if (!match?.[1]) continue;
        const indexes =
          item.extended?.hashes?.[origin]?.find(([hash]) => hash === id)?.[1] ??
          [];
        const tiers = indexes.map(
          (index) => item.extended?.mods?.[origin]?.[index]?.tier,
        );
        const tier =
          tiers.length === 1 && /^[PS]\d+$/.test(tiers[0] ?? '')
            ? Number(tiers[0]?.slice(1))
            : undefined;
        mods.push({
          id,
          value: Number(match[1]),
          ...(tier !== undefined ? { tier } : {}),
        });
      }
    }
  }
  return mods;
}

/** Only exact mapped English modifier text is numeric evidence. Unrecognized mods remain raw. */
export function normalizeTradeCompatibleListing(
  raw: unknown,
  target: MarketTarget,
) {
  const parsed = listingSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError('PROVIDER_RESPONSE_INVALID');
  const { item, listing, id } = parsed.data;
  const mods = normalizedMods(item);
  const configured =
    target.tradeSearch?.groups.flatMap((group) => group.filters) ?? [];
  const aliases = mods.flatMap((mod) => {
    const key =
      configured.find((stat) => stat.id === mod.id)?.key ??
      tradeStatMappings[mod.id]?.key;
    return key ? [{ ...mod, id: key }] : [];
  });
  const quality = item.properties?.find((property) => property.type === 6)
    ?.values[0]?.[0];
  const rarity =
    item.rarity?.toLowerCase() ??
    ['normal', 'magic', 'rare', 'unique'][item.frameType ?? -1];
  const modArraysPresent = item.explicitMods !== undefined;
  const verifiedAbsentStats = configured.flatMap((stat) => {
    const origin = stat.id.split('.')[0] ?? '';
    const hashes = item.extended?.hashes?.[origin];
    return hashes && !hashes.some(([id]) => id === stat.id)
      ? [stat.id, stat.key ?? tradeStatMappings[stat.id]?.key ?? stat.id]
      : [];
  });
  return {
    externalId: id,
    price: listing.price?.amount ?? null,
    ...(listing.price ? { currency: listing.price.currency } : {}),
    ...(listing.indexed ? { listedAt: listing.indexed } : {}),
    ...(listing.fee !== undefined ? { fee: listing.fee } : {}),
    rawListing: jsonRecord.parse(raw),
    item: jsonRecord.parse({
      ...item,
      ...((item.baseType ?? item.typeLine)
        ? { baseType: item.baseType ?? item.typeLine }
        : {}),
      ...(rarity ? { rarity } : {}),
      ...(item.ilvl !== undefined ? { itemLevel: item.ilvl } : {}),
      ...(quality && /^\+?\d+%$/.test(quality)
        ? { quality: Number(quality.replace(/[+%]/g, '')) }
        : {}),
      // Patch comes from the explicitly configured search scope, not from an inferred current league.
      patch: target.patch,
      normalizationVersion: 'trade-compatible-v1',
      seller: listing.account.name,
      status: 'listed',
      ...(listing.price ? { currency: listing.price.currency } : {}),
      mods: [...mods, ...aliases],
      modsComplete: false,
      verifiedAbsentStats,
      ...(modArraysPresent
        ? {
            influences: Object.entries(item.influences ?? {})
              .filter(([, present]) => present)
              .map(([name]) => name),
          }
        : {}),
    }),
  };
}

/** Website-compatible transport, separate from the developer API client. No protection evasion. */
export class TradeCompatibleTransport implements MarketCollectionTransport {
  readonly #config: TradeCompatibleConfig;
  readonly #fetch: typeof fetch;
  readonly #targets = new Map<string, MarketTarget>();
  readonly #cache = new Map<
    string,
    {
      expires: number;
      response: MarketCollectionTransportResponse<unknown> & {
        capturedAt: string;
      };
    }
  >();
  readonly #clock: () => Date;
  #denied = false;
  connectionStatus: NonNullable<MarketCollectionSource['connectionStatus']> =
    'UNAVAILABLE';

  constructor(
    config: TradeCompatibleConfig,
    options: { fetcher?: typeof fetch; clock?: () => Date } = {},
  ) {
    this.#config = config;
    this.#fetch = options.fetcher ?? fetch;
    this.#clock = options.clock ?? (() => new Date());
  }

  async #request(
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<
    MarketCollectionTransportResponse<unknown> & { capturedAt: string }
  > {
    if (this.#denied) throw new DomainError('MARKET_ACCESS_BLOCKED');
    signal.throwIfAborted();
    const key = JSON.stringify([path, body]);
    const cached = this.#cache.get(key);
    if (cached && cached.expires > this.#clock().getTime())
      return { ...cached.response, cached: true };
    try {
      const response = await this.#fetch(new URL(path, this.#config.baseURL), {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'manual',
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(this.#config.timeoutMs),
        ]),
        headers: {
          Accept: 'application/json',
          'User-Agent': this.#config.userAgent,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.#config.sessionId
            ? { Cookie: `POESESSID=${this.#config.sessionId}` }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // Redirects and challenges are access denial, never followed with credentials.
      const status =
        (response.status >= 300 && response.status < 400) ||
        response.headers.get('cf-mitigated') === 'challenge'
          ? 403
          : response.status;
      this.connectionStatus =
        status === 401
          ? 'AUTH_REQUIRED'
          : status === 403
            ? 'ACCESS_DENIED'
            : status === 429
              ? 'RATE_LIMITED'
              : status >= 400
                ? 'UNAVAILABLE'
                : 'CONNECTED';
      if (status === 401 || status === 403) this.#denied = true;
      if (status >= 400) {
        await response.body?.cancel();
        return {
          cached: false,
          status,
          headers: response.headers,
          data: null,
          capturedAt: this.#clock().toISOString(),
        };
      }
      const reader = response.body?.getReader();
      if (!reader) throw new DomainError('PROVIDER_RESPONSE_INVALID');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          throw new DomainError('PROVIDER_RESPONSE_INVALID');
        }
        chunks.push(value);
      }
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new DomainError('PROVIDER_RESPONSE_INVALID');
      }
      const data = this.#redact(value);
      const result = {
        cached: false,
        status,
        headers: response.headers,
        data,
        capturedAt: this.#clock().toISOString(),
      };
      if (
        !/no-store|no-cache/i.test(response.headers.get('cache-control') ?? '')
      ) {
        if (this.#cache.size >= 100) this.#cache.clear();
        this.#cache.set(key, {
          expires: this.#clock().getTime() + 15_000,
          response: result,
        });
      }
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      this.connectionStatus = 'UNAVAILABLE';
      // Fetch errors can include headers/URLs in injected transports. Do not retain their cause.
      throw error instanceof DomainError
        ? error
        : new DomainError('PROVIDER_UNAVAILABLE');
    }
  }

  #redact(value: unknown): unknown {
    if (typeof value === 'string')
      return this.#config.sessionId
        ? value.split(this.#config.sessionId).join('[REDACTED]')
        : value;
    if (Array.isArray(value)) return value.map((entry) => this.#redact(entry));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          /cookie|authorization|password|token|session/i.test(key)
            ? '[REDACTED]'
            : this.#redact(entry),
        ]),
      );
    return value;
  }

  async search({
    target,
    signal,
  }: {
    target: MarketTarget;
    signal: AbortSignal;
  }) {
    const generated = generateMarketTradeQuery(target);
    const response = await this.#request(
      `/api/trade/search/${encodeURIComponent(target.league)}`,
      signal,
      generated.request,
    );
    if (response.status >= 400)
      return {
        ...response,
        data: {
          capturedAt: null,
          coverage: 'unknown' as const,
          currency: null,
          ids: [],
          queryId: null,
          reportedTotal: null,
        },
      };
    const parsed = searchSchema.safeParse(response.data);
    if (!parsed.success) {
      this.connectionStatus = 'UNAVAILABLE';
      throw new DomainError('PROVIDER_RESPONSE_INVALID');
    }
    const data = parsed.data;
    if (data.result.length > data.total)
      throw new DomainError('PROVIDER_RESPONSE_INVALID');
    if (this.#targets.size >= 100) this.#targets.clear();
    this.#targets.set(data.id, target);
    return {
      ...response,
      data: {
        capturedAt: response.capturedAt,
        coverage:
          data.inexact || data.total > data.result.length
            ? ('partial' as const)
            : ('complete' as const),
        currency: target.tradeSearch?.currency ?? null,
        ids: data.result,
        queryId: data.id,
        reportedTotal: data.total,
        inexact: data.inexact ?? false,
        sourceUrl: `${this.#config.baseURL}/trade/search/${encodeURIComponent(target.league)}/${encodeURIComponent(data.id)}`,
        request: jsonRecord.parse({
          version: generated.version,
          hash: generated.hash,
          scope: generated.scope,
          ...generated.request,
        }),
        raw: jsonRecord.parse(response.data),
      },
    };
  }

  async fetchDetails({
    ids,
    queryId,
    signal,
    target: requestedTarget,
  }: {
    ids: string[];
    queryId: string | null;
    signal: AbortSignal;
    target?: MarketTarget;
  }) {
    const target =
      requestedTarget ?? (queryId ? this.#targets.get(queryId) : undefined);
    if (
      !target ||
      !queryId ||
      !identifier.safeParse(queryId).success ||
      ids.length < 1 ||
      ids.length > 10 ||
      ids.some((id) => !identifier.safeParse(id).success)
    )
      throw new DomainError('MARKET_QUERY_INVALID');
    const response = await this.#request(
      `/api/trade/fetch/${ids.join(',')}?query=${encodeURIComponent(queryId)}`,
      signal,
    );
    if (response.status >= 400) return { ...response, data: [] };
    const parsed = fetchSchema.safeParse(response.data);
    if (!parsed.success) {
      this.connectionStatus = 'UNAVAILABLE';
      throw new DomainError('PROVIDER_RESPONSE_INVALID');
    }
    return {
      ...response,
      data: parsed.data.result.map((entry) =>
        entry === null ? null : normalizeTradeCompatibleListing(entry, target),
      ),
    };
  }
}
