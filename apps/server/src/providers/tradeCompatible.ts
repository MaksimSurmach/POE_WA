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
import { convertMarketQuote } from '../marketCurrency.js';
import type { MarketEconomyRepository } from '../marketEconomy.js';

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
// Trade also returns compressed queries as IDs, longer than listing hashes.
const queryIdentifier = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .max(4096);
const searchSchema = z.object({
  id: queryIdentifier,
  result: z.array(identifier).max(100_000),
  total: z.number().int().nonnegative(),
  inexact: z.boolean().optional(),
});
const modifierSchema = z.union([
  z.string(),
  z
    .object({
      description: z.string(),
      domain: z.string(),
      hash: z.string(),
      flags: z
        .object({
          crafted: z.boolean().optional(),
          fractured: z.boolean().optional(),
        })
        .optional(),
      mods: z.array(z.object({ tier: z.string().optional() })).optional(),
    })
    .passthrough(),
]);
const itemSchema = z
  .object({
    verified: z.boolean().optional(),
    baseType: z.string().optional(),
    typeLine: z.string().optional(),
    league: z.string().optional(),
    rarity: z.string().optional(),
    frameType: z.number().int().optional(),
    ilvl: z.number().int().optional(),
    corrupted: z.boolean().optional(),
    fractured: z.boolean().optional(),
    synthesised: z.boolean().optional(),
    enchantMods: z.array(modifierSchema).optional(),
    influences: z.record(z.string(), z.boolean()).optional(),
    explicitMods: z.array(modifierSchema).optional(),
    implicitMods: z.array(modifierSchema).optional(),
    craftedMods: z.array(modifierSchema).optional(),
    fracturedMods: z.array(modifierSchema).optional(),
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
              z.tuple([
                z.string(),
                z.array(z.number().int().nonnegative()).nullable(),
              ]),
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
        fee: z
          .union([
            z.number().finite().nonnegative(),
            z.object({
              amount: z.number().finite().nonnegative(),
              currency: z.string(),
            }),
          ])
          .optional(),
      })
      .passthrough(),
    item: itemSchema,
  })
  .passthrough();
const fetchSchema = z.object({
  result: z.array(listingSchema.nullable()).max(10),
});
const jsonRecord = z.record(z.string(), z.json());

const origins = [
  'explicit',
  'implicit',
  'crafted',
  'fractured',
  'enchant',
] as const;
function modifierLines(item: z.infer<typeof itemSchema>) {
  return origins.flatMap((origin) =>
    (item[`${origin}Mods`] ?? []).map((mod) =>
      typeof mod === 'string'
        ? { origin, description: mod, hash: undefined, tier: undefined }
        : {
            origin: mod.flags?.fractured
              ? 'fractured'
              : mod.flags?.crafted
                ? 'crafted'
                : mod.domain,
            description: mod.description,
            hash: mod.hash.replace(/^stat\./, ''),
            tier: mod.mods?.length === 1 ? mod.mods[0]?.tier : undefined,
          },
    ),
  );
}

function normalizedMods(item: z.infer<typeof itemSchema>) {
  const mods: Array<{ id: string; value: number; tier?: number }> = [];
  for (const origin of origins) {
    const lines = modifierLines(item).filter((line) => line.origin === origin);
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
        if (
          line.hash !== undefined &&
          ![
            id,
            id.split('|')[0],
            id.split('.')[1],
            id.split('.')[1]?.split('|')[0],
          ].includes(line.hash)
        )
          continue;
        const match = new RegExp(pattern).exec(line.description);
        if (!match) continue;
        const indexes =
          item.extended?.hashes?.[origin]?.find(([hash]) => hash === id)?.[1] ??
          [];
        const tiers = indexes.map(
          (index) => item.extended?.mods?.[origin]?.[index]?.tier,
        );
        const rawTier =
          line.tier ?? (tiers.length === 1 ? tiers[0] : undefined);
        const tier = /^[PS][1-9]\d*$/.test(rawTier ?? '')
          ? Number(rawTier?.slice(1))
          : undefined;
        mods.push({
          id,
          value: match[1] === undefined ? 1 : Number(match[1]),
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
  const elementalResistances = { fire: 0, cold: 0, lightning: 0 };
  // shortcut: hybrid/conditional resistances remain unknown; add exact mappings before pricing those profiles.
  let resistanceEvidenceComplete = item.explicitMods !== undefined;
  for (const { description: line } of modifierLines(item)) {
    if (!/Resistance/i.test(line) || /^\+?\d+% to Chaos Resistance$/.test(line))
      continue;
    const match = /^([+-]?\d+)% to (Fire|Cold|Lightning) Resistance$/.exec(
      line,
    );
    if (!match) {
      resistanceEvidenceComplete = false;
      continue;
    }
    const key = match[2]?.toLowerCase();
    if (key === 'fire' || key === 'cold' || key === 'lightning')
      elementalResistances[key] += Number(match[1]);
  }
  if (resistanceEvidenceComplete)
    mods.push({
      id: 'pseudo.pseudo_total_elemental_resistance',
      value:
        elementalResistances.fire +
        elementalResistances.cold +
        elementalResistances.lightning,
    });
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
    ...(typeof listing.fee === 'number'
      ? { fee: listing.fee }
      : listing.fee?.currency === 'gold'
        ? { fee: listing.fee.amount }
        : {}),
    rawListing: jsonRecord.parse(raw),
    item: jsonRecord.parse({
      ...item,
      // Full Trade items omit false flags; incomplete legacy imports retain unknown flags.
      ...(item.verified !== undefined
        ? {
            corrupted: item.corrupted ?? false,
            synthesised: item.synthesised ?? false,
            fractured:
              item.fractured ??
              modifierLines(item).some((line) => line.origin === 'fractured'),
          }
        : {}),
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
      realm: target.realm,
      normalizationVersion: 'trade-compatible-v3',
      seller: listing.account.name,
      status: 'listed',
      ...(listing.price ? { currency: listing.price.currency } : {}),
      mods: [...mods, ...aliases],
      modsComplete: false,
      verifiedAbsentStats,
      ...(resistanceEvidenceComplete ? { elementalResistances } : {}),
      ...(modArraysPresent || item.verified !== undefined
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
  readonly #economy:
    | (Pick<MarketEconomyRepository, 'find'> &
        Partial<Pick<MarketEconomyRepository, 'latest'>>)
    | undefined;
  #denied = false;
  connectionStatus: NonNullable<MarketCollectionSource['connectionStatus']> =
    'UNAVAILABLE';

  constructor(
    config: TradeCompatibleConfig,
    options: {
      fetcher?: typeof fetch;
      clock?: () => Date;
      economy?: Pick<MarketEconomyRepository, 'find'> &
        Partial<Pick<MarketEconomyRepository, 'latest'>>;
    } = {},
  ) {
    this.#config = config;
    this.#fetch = options.fetcher ?? fetch;
    this.#clock = options.clock ?? (() => new Date());
    this.#economy = options.economy;
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
      !queryIdentifier.safeParse(queryId).success ||
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
    const rawResults = jsonRecord.parse(response.data).result;
    if (!Array.isArray(rawResults))
      throw new DomainError('PROVIDER_RESPONSE_INVALID');
    const exchangeSnapshotId =
      target.tradeSearch?.exchangeSnapshotId ??
      (target.tradeSearch?.includeOtherCurrencies
        ? (await this.#economy?.latest?.(target.league, 'Currency'))?.id
        : undefined);
    const listings = await Promise.all(
      rawResults.map(async (entry) => {
        if (entry === null) return null;
        const row = normalizeTradeCompatibleListing(entry, target);
        if (row.price === null || !row.currency || !target.tradeSearch)
          return row;
        const converted = await convertMarketQuote({
          money: { amount: String(row.price), currency: row.currency },
          currency: target.tradeSearch.currency,
          target,
          capturedAt: response.capturedAt,
          now: this.#clock().getTime(),
          dataKind: 'observed',
          ...(this.#economy ? { economy: this.#economy } : {}),
          ...(exchangeSnapshotId ? { exchangeSnapshotId } : {}),
        });
        return converted?.exchange
          ? {
              ...row,
              price: Number(converted.money.amount),
              currency: converted.money.currency,
              item: {
                ...row.item,
                currency: converted.money.currency,
                originalPrice: row.price,
                originalCurrency: row.currency,
                exchange: converted.exchange,
              },
            }
          : row;
      }),
    );
    return { ...response, data: listings };
  }
}
