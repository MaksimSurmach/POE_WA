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
import { domainErrorCodeSchema } from '@poe-worksmith/contracts';
import {
  completeOutputLimit,
  isCompleteSortedPriceSample,
  type MarketCollectionAdapter,
} from '../marketCollection.js';
import {
  recipeQueryTarget,
  requiresCompleteOutputCoverage,
} from '../recipeMarket.js';

import type { ProviderCircuitGate } from '../circuitBreaker.js';
import type { RateLimitGate } from '../rateLimitController.js';
import { ProviderContractError } from './providerContractError.js';
import type { Metrics } from '../observability/metrics.js';

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
const exchangeSideSchema = z
  .object({
    amount: z.number().finite().positive(),
    currency: z.string().trim().min(1),
    stock: z.number().finite().nonnegative().optional(),
  })
  .loose();
const exchangeListingSchema = z.object({
  id: z.string().min(1),
  listing: z.object({
    account: z.object({ name: z.string().min(1) }).loose(),
    indexed: z.iso.datetime({ offset: true }),
    offers: z.array(
      z
        .object({ exchange: exchangeSideSchema, item: exchangeSideSchema })
        .loose(),
    ),
  }),
});
const exchangeResponseSchema = z
  .object({
    id: z.string().min(1),
    result: z
      .union([
        z.record(z.string(), exchangeListingSchema),
        z.array(exchangeListingSchema).max(0),
      ])
      .transform((result) =>
        Array.isArray(result) ? result : Object.values(result),
      ),
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
        fee: z.unknown().optional(),
        indexed: z.iso.datetime({ offset: true }),
        price: moneySchema,
      })
      .loose(),
  })
  .loose();
const fetchResponseSchema = z
  .object({ result: z.array(fetchedListingSchema) })
  .loose();

const defaultBaseUrl = 'https://www.pathofexile.com';
const defaultRequestTimeoutMs = 15_000;
const maximumListings = 10;
type ProviderLogger = {
  warn(context: unknown, message: string): void;
  info?(context: unknown, message: string): void;
};

export type PoeTradeFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export class PoeTradeClient implements MarketSearchProvider {
  readonly id = 'poe-trade';
  readonly #collectionTimeoutMs: number;
  readonly #collectionSource: MarketCollectionAdapter | undefined;
  readonly #allowRequests: boolean;
  readonly #allowQueuedCollection: boolean;
  #accessBlocked = false;
  readonly #shutdown = new AbortController();
  readonly #baseUrl: URL;
  readonly #clock: () => Date;
  readonly #circuits: ProviderCircuitGate | undefined;
  readonly #fetch: PoeTradeFetch;
  readonly #rateLimits: RateLimitGate | undefined;
  readonly #requestTimeoutMs: number;
  readonly #userAgent: string;
  readonly #logger: ProviderLogger | undefined;
  readonly #metrics: Metrics | undefined;

  constructor(options: {
    baseUrl?: string;
    collectionSource?: MarketCollectionAdapter;
    collectionTimeoutMs?: number;
    allowRequests?: boolean;
    allowQueuedCollection?: boolean;
    circuits?: ProviderCircuitGate;
    clock?: () => Date;
    fetch?: PoeTradeFetch;
    logger?: ProviderLogger;
    metrics?: Metrics;
    rateLimits?: RateLimitGate;
    requestTimeoutMs?: number;
    userAgent: string;
  }) {
    this.#collectionTimeoutMs = options.collectionTimeoutMs ?? 15 * 60_000;
    this.#collectionSource = options.collectionSource;
    this.#allowRequests = options.allowRequests ?? true;
    this.#allowQueuedCollection = options.allowQueuedCollection ?? false;
    this.#baseUrl = new URL(options.baseUrl ?? defaultBaseUrl);
    this.#circuits = options.circuits;
    this.#clock = options.clock ?? (() => new Date());
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#logger = options.logger;
    this.#metrics = options.metrics;
    this.#rateLimits = options.rateLimits;
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? defaultRequestTimeoutMs;
    this.#userAgent = options.userAgent.trim();
    if (
      this.#userAgent.length === 0 ||
      !Number.isInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 1
    ) {
      throw new TypeError('PoE Trade client options are invalid');
    }
  }

  stop() {
    this.#shutdown.abort();
  }

  async search(request: MarketSearchRequest): Promise<MarketSearchResult> {
    if (this.#shutdown.signal.aborted)
      throw new DomainError('MARKET_COLLECTION_CANCELLED');
    const queuedCollection =
      this.#allowQueuedCollection && Boolean(request.query.handbookTarget);
    if ((!this.#allowRequests && !queuedCollection) || this.#accessBlocked)
      throw new DomainError('MARKET_ACCESS_BLOCKED');
    if (request.query.handbookTarget) {
      if (
        !this.#collectionSource ||
        (this.#collectionSource.descriptor.access !== 'authorized' &&
          !queuedCollection)
      )
        throw new DomainError('MARKET_ACCESS_BLOCKED');
      const target = recipeQueryTarget(request.query.handbookTarget);
      if (target.league !== request.league)
        throw new DomainError('MARKET_QUERY_INVALID');
      const batch = await this.#collectionSource.collect({
        target,
        // Batch time includes shared rate-limit waits; transport timeouts apply to each HTTP call.
        signal: AbortSignal.any([
          this.#shutdown.signal,
          AbortSignal.timeout(this.#collectionTimeoutMs),
        ]),
      });
      if (this.#shutdown.signal.aborted || batch.cancelled)
        throw new DomainError('MARKET_COLLECTION_CANCELLED');
      if (batch.errorCode) {
        if (
          [
            'PROVIDER_AUTH_FAILED',
            'PROVIDER_ACCESS_DENIED',
            'PROVIDER_CHALLENGE',
            'MARKET_ACCESS_BLOCKED',
          ].includes(batch.errorCode)
        )
          this.#accessBlocked = true;
        const code = domainErrorCodeSchema.safeParse(batch.errorCode);
        throw new DomainError(
          code.success ? code.data : 'MARKET_COLLECTION_FAILED',
        );
      }
      if (!batch.capturedAt) throw new DomainError('PROVIDER_RESPONSE_INVALID');
      const skippedOversizedOutput =
        requiresCompleteOutputCoverage(request.query) &&
        batch.coverage === 'partial' &&
        batch.batchCount === 0 &&
        Math.max(batch.returnedCount, batch.reportedTotal ?? 0) >
          completeOutputLimit;
      if (
        (batch.reportedTotal ?? 0) > 0 &&
        batch.fetchedCount === 0 &&
        !skippedOversizedOutput
      )
        throw new DomainError('MARKET_COLLECTION_FAILED');
      const fetchedAt = new Date(batch.capturedAt);
      return {
        provider: this.id,
        fetchedAt,
        coverage: batch.coverage,
        sortedPageComplete:
          !requiresCompleteOutputCoverage(request.query) &&
          batch.sortedSampleComplete === undefined &&
          batch.coverage === 'partial' &&
          batch.inexact === false &&
          batch.fetchedCount === batch.returnedCount &&
          batch.returnedCount > 0 &&
          (batch.reportedTotal ?? 0) > batch.returnedCount &&
          z
            .object({ sort: z.object({ price: z.literal('asc') }) })
            .safeParse(batch.searchEvidence?.request).success,
        sortedSampleComplete:
          !requiresCompleteOutputCoverage(request.query) &&
          batch.sortedSampleComplete === true &&
          isCompleteSortedPriceSample(batch, target),
        totalResults: batch.reportedTotal ?? batch.returnedCount,
        listings: batch.listings.flatMap((row) =>
          row.price === null ||
          !row.currency ||
          !row.externalId ||
          typeof row.item.seller !== 'string'
            ? []
            : [
                {
                  id: row.externalId,
                  account: row.item.seller,
                  ageSeconds: row.listedAt
                    ? Math.max(
                        0,
                        Math.floor(
                          (fetchedAt.getTime() - Date.parse(row.listedAt)) /
                            1000,
                        ),
                      )
                    : 0,
                  indexedAt: new Date(row.listedAt ?? batch.capturedAt!),
                  fee:
                    row.fee === undefined
                      ? null
                      : { amount: String(row.fee), currency: 'gold' },
                  price: { amount: String(row.price), currency: row.currency },
                  item: { ...row.item, rawListing: row.rawListing ?? null },
                },
              ],
        ),
      };
    }
    const league = request.league.trim();
    if (league.length === 0) throw new DomainError('MARKET_QUERY_INVALID');
    const preparedSearch = buildSearchRequest(request.query);
    const searchUrl = new URL(
      `/api/trade/${preparedSearch.kind}/${encodeURIComponent(league)}`,
      this.#baseUrl,
    );
    const rawSearch = await this.#request(
      preparedSearch.kind === 'exchange' ? 'trade-exchange' : 'trade-search',
      searchUrl,
      {
        body: JSON.stringify(preparedSearch.body),
        headers: this.#headers(true),
        method: 'POST',
      },
    );
    if (preparedSearch.kind === 'exchange') {
      const exchange = parseProviderResponse(
        exchangeResponseSchema,
        rawSearch,
        this.id,
        'trade-exchange',
        this.#logger,
      );
      const fetchedAt = this.#clock();
      const listings = exchange.result
        .flatMap((entry) =>
          entry.listing.offers.flatMap((offer, offerIndex) => {
            const { exchange: have, item: want } = offer;
            return have.amount > 0 && want.amount > 0
              ? [
                  normalizeExchangeListing(
                    { ...entry, id: `${entry.id}:${offerIndex}` },
                    have.amount / want.amount,
                    have.currency,
                    fetchedAt,
                    offer,
                  ),
                ]
              : [];
          }),
        )
        .slice(0, maximumListings);
      return {
        fetchedAt,
        listings,
        provider: this.id,
        totalResults: exchange.total,
      };
    }
    const search = parseProviderResponse(
      searchResponseSchema,
      rawSearch,
      this.id,
      'trade-search',
      this.#logger,
    );
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
    const fetched = parseProviderResponse(
      fetchResponseSchema,
      rawFetch,
      this.id,
      'trade-fetch',
      this.#logger,
    );
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
    const started = performance.now();
    this.#logger?.info?.(
      { endpoint, provider: this.id },
      'provider.request.started',
    );
    await this.#circuits?.beforeRequest(endpoint);
    let response: Response;
    try {
      await this.#rateLimits?.waitForPermit(endpoint, this.#shutdown.signal);
      this.#shutdown.signal.throwIfAborted();
      response = await this.#fetch(url, {
        ...init,
        signal: AbortSignal.any([
          this.#shutdown.signal,
          AbortSignal.timeout(this.#requestTimeoutMs),
        ]),
      });
    } catch (error) {
      const providerError = this.#shutdown.signal.aborted
        ? new DomainError('MARKET_COLLECTION_CANCELLED')
        : error instanceof DomainError
          ? error
          : new DomainError('PROVIDER_UNAVAILABLE', { cause: error });
      if (providerError.code !== 'MARKET_COLLECTION_CANCELLED')
        await this.#circuits?.recordFailure(endpoint, providerError);
      this.#logger?.warn(
        { endpoint, provider: this.id, errorCode: providerError.code },
        'provider.request.failed',
      );
      this.#metrics?.providerRequests.inc({
        provider: this.id,
        endpoint,
        outcome: 'failed',
      });
      this.#metrics?.providerRequestDuration.observe(
        { provider: this.id, endpoint, outcome: 'failed' },
        (performance.now() - started) / 1000,
      );
      throw providerError;
    }

    if (this.#shutdown.signal.aborted)
      throw new DomainError('MARKET_COLLECTION_CANCELLED');
    await this.#rateLimits?.observeResponse(endpoint, response);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        this.#accessBlocked = true;
      const providerError = mapHttpError(response.status);
      await this.#circuits?.recordFailure(endpoint, providerError);
      this.#logger?.warn(
        { endpoint, provider: this.id, errorCode: providerError.code },
        'provider.request.failed',
      );
      this.#metrics?.providerRequests.inc({
        provider: this.id,
        endpoint,
        outcome: 'failed',
      });
      this.#metrics?.providerRequestDuration.observe(
        { provider: this.id, endpoint, outcome: 'failed' },
        (performance.now() - started) / 1000,
      );
      throw providerError;
    }
    await this.#circuits?.recordSuccess(endpoint);
    this.#logger?.info?.(
      { endpoint, provider: this.id, statusCode: response.status },
      'provider.request.completed',
    );
    this.#metrics?.providerRequests.inc({
      provider: this.id,
      endpoint,
      outcome: 'success',
    });
    this.#metrics?.providerRequestDuration.observe(
      { provider: this.id, endpoint, outcome: 'success' },
      (performance.now() - started) / 1000,
    );

    if (response.headers.get('content-type')?.includes('text/html')) {
      this.#accessBlocked = true;
      throw new DomainError('PROVIDER_CHALLENGE');
    }
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
  const fee = moneySchema.safeParse(entry.listing.fee);
  return {
    account: entry.listing.account.name,
    ageSeconds: Math.max(
      0,
      Math.floor((fetchedAt.getTime() - indexedAt.getTime()) / 1000),
    ),
    fee: fee.success ? normalizeMoney(fee.data) : null,
    id: entry.id,
    indexedAt,
    item: entry.item,
    price: normalizeMoney(entry.listing.price),
  };
}

function normalizeExchangeListing(
  entry: z.infer<typeof exchangeListingSchema>,
  unitPrice: number,
  currency: string,
  fetchedAt: Date,
  offer: z.infer<typeof exchangeListingSchema>['listing']['offers'][number],
): MarketListing {
  const indexedAt = new Date(entry.listing.indexed);
  return {
    account: entry.listing.account.name,
    ageSeconds: Math.max(
      0,
      Math.floor((fetchedAt.getTime() - indexedAt.getTime()) / 1000),
    ),
    fee: null,
    id: entry.id,
    indexedAt,
    item: {
      stock: offer.item.stock ?? null,
      rawOffer: jsonObjectSchema.parse(offer),
    },
    price: { amount: String(unitPrice), currency },
  };
}

function normalizeMoney(value: z.infer<typeof moneySchema>): ProviderMoney {
  return {
    amount: String(value.amount),
    currency: value.currency,
  };
}

function parseProviderResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  provider: string,
  endpoint: string,
  logger: ProviderLogger | undefined,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const error = new ProviderContractError({
      endpoint,
      issuePaths: result.error.issues.map((issue) => issue.path.join('.')),
      provider,
    });
    logger?.warn(
      {
        endpoint: error.endpoint,
        errorCode: error.code,
        issuePaths: error.issuePaths,
        provider: error.provider,
      },
      'provider schema mismatch',
    );
    throw error;
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
