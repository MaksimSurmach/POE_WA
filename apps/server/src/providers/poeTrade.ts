import {
  type CanonicalJsonObject,
  type CanonicalJsonValue,
  DomainError,
  type MarketListing,
  type MarketSearchProvider,
  type MarketSearchRequest,
  type MarketSearchResult,
  type ProviderMoney,
} from '@poe-worksmith/domain';
import { z } from 'zod';

import type { RateLimitGate } from '../rateLimitController.js';

const jsonValueSchema: z.ZodType<CanonicalJsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const jsonObjectSchema: z.ZodType<CanonicalJsonObject> = z.record(
  z.string(),
  jsonValueSchema,
);
const amountSchema = z.union([
  z.number().finite().nonnegative(),
  z.string().regex(/^\d+(?:\.\d+)?$/),
]);
const moneySchema = z
  .object({ amount: amountSchema, currency: z.string().trim().min(1) })
  .loose();
const searchResponseSchema = z
  .object({
    id: z.string().min(1),
    result: z.array(z.string().min(1)),
    total: z.number().int().nonnegative(),
  })
  .loose();
const fetchedListingSchema = z
  .object({
    id: z.string().min(1),
    item: jsonObjectSchema,
    listing: z
      .object({
        account: z.object({ name: z.string().min(1) }).loose(),
        fee: moneySchema.nullish(),
        indexed: z.iso.datetime(),
        price: moneySchema,
      })
      .loose(),
  })
  .loose();
const fetchResponseSchema = z
  .object({ result: z.array(fetchedListingSchema) })
  .loose();

const defaultBaseUrl = 'https://www.pathofexile.com';
const maximumListings = 10;

export type PoeTradeFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export class PoeTradeClient implements MarketSearchProvider {
  readonly id = 'poe-trade';
  readonly #baseUrl: URL;
  readonly #clock: () => Date;
  readonly #fetch: PoeTradeFetch;
  readonly #rateLimits: RateLimitGate | undefined;
  readonly #userAgent: string;

  constructor(options: {
    baseUrl?: string;
    clock?: () => Date;
    fetch?: PoeTradeFetch;
    rateLimits?: RateLimitGate;
    userAgent: string;
  }) {
    this.#baseUrl = new URL(options.baseUrl ?? defaultBaseUrl);
    this.#clock = options.clock ?? (() => new Date());
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#rateLimits = options.rateLimits;
    this.#userAgent = options.userAgent.trim();
    if (this.#userAgent.length === 0) {
      throw new TypeError('userAgent must not be empty');
    }
  }

  async search(request: MarketSearchRequest): Promise<MarketSearchResult> {
    const league = request.league.trim();
    if (league.length === 0) throw new DomainError('MARKET_QUERY_INVALID');
    const preparedSearch = buildSearchRequest(request.query);
    const searchUrl = new URL(
      `/api/trade/${preparedSearch.kind}/${encodeURIComponent(league)}`,
      this.#baseUrl,
    );
    const rawSearch = await this.#request('trade-search', searchUrl, {
      body: JSON.stringify(preparedSearch.body),
      headers: this.#headers(true),
      method: 'POST',
    });
    const search = parseProviderResponse(searchResponseSchema, rawSearch);
    const resultIds = search.result.slice(0, maximumListings);

    if (resultIds.length === 0) {
      return {
        fetchedAt: this.#clock(),
        listings: [],
        provider: this.id,
        totalResults: search.total,
      };
    }

    const fetchUrl = new URL(
      `/api/trade/fetch/${resultIds.map(encodeURIComponent).join(',')}`,
      this.#baseUrl,
    );
    fetchUrl.searchParams.set('query', search.id);
    const rawFetch = await this.#request('trade-fetch', fetchUrl, {
      headers: this.#headers(false),
      method: 'GET',
    });
    const fetched = parseProviderResponse(fetchResponseSchema, rawFetch);
    const fetchedAt = this.#clock();
    const listingById = new Map(
      fetched.result.map((entry) => [entry.id, entry] as const),
    );
    const listings = resultIds.flatMap((id) => {
      const entry = listingById.get(id);
      return entry ? [normalizeListing(entry, fetchedAt)] : [];
    });

    return {
      fetchedAt,
      listings,
      provider: this.id,
      totalResults: search.total,
    };
  }

  #headers(withBody: boolean) {
    return {
      Accept: 'application/json',
      ...(withBody ? { 'Content-Type': 'application/json' } : {}),
      'User-Agent': this.#userAgent,
    };
  }

  async #request(endpoint: string, url: URL, init: RequestInit) {
    await this.#rateLimits?.waitForPermit(endpoint);
    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('PROVIDER_UNAVAILABLE', { cause: error });
    }

    await this.#rateLimits?.observeResponse(endpoint, response);

    if (!response.ok) throw mapHttpError(response.status);

    try {
      return (await response.json()) as unknown;
    } catch (error) {
      throw new DomainError('PROVIDER_RESPONSE_INVALID', { cause: error });
    }
  }
}

function buildSearchRequest(source: CanonicalJsonObject): {
  body: CanonicalJsonObject;
  kind: 'exchange' | 'search';
} {
  const query = source.query;
  if (isJsonObject(query)) {
    const sort = source.sort;
    if (sort !== undefined && !isJsonObject(sort)) {
      throw new DomainError('MARKET_QUERY_INVALID');
    }
    return {
      body: {
        ...source,
        query: {
          ...query,
          status: { option: 'securable' },
        },
        sort: { price: 'asc' },
      },
      kind: 'search',
    };
  }
  const exchange = source.exchange;
  if (isJsonObject(exchange)) {
    return {
      body: {
        ...source,
        exchange: {
          ...exchange,
          status: { option: 'online' },
        },
      },
      kind: 'exchange',
    };
  }
  throw new DomainError('MARKET_QUERY_INVALID');
}

function normalizeListing(
  entry: z.infer<typeof fetchedListingSchema>,
  fetchedAt: Date,
): MarketListing {
  const indexedAt = new Date(entry.listing.indexed);
  return {
    account: entry.listing.account.name,
    ageSeconds: Math.max(
      0,
      Math.floor((fetchedAt.getTime() - indexedAt.getTime()) / 1000),
    ),
    fee: entry.listing.fee ? normalizeMoney(entry.listing.fee) : null,
    id: entry.id,
    indexedAt,
    item: entry.item,
    price: normalizeMoney(entry.listing.price),
  };
}

function normalizeMoney(value: z.infer<typeof moneySchema>): ProviderMoney {
  return {
    amount: String(value.amount),
    currency: value.currency,
  };
}

function parseProviderResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DomainError('PROVIDER_RESPONSE_INVALID', {
      cause: result.error,
    });
  }
  return result.data;
}

function mapHttpError(status: number) {
  if (status === 429) return new DomainError('PROVIDER_RATE_LIMITED');
  if (status === 401 || status === 403) {
    return new DomainError('PROVIDER_AUTH_FAILED');
  }
  if (status >= 400 && status < 500) {
    return new DomainError('MARKET_QUERY_INVALID');
  }
  return new DomainError('PROVIDER_UNAVAILABLE');
}

function isJsonObject(value: unknown): value is CanonicalJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
