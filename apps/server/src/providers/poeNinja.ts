import {
  type CurrencyRateProvider,
  type CurrencyRateQuote,
  type CurrencyRateRequest,
  DomainError,
  type MaterialPriceProvider,
  type MaterialPriceQuote,
  type MaterialPriceRequest,
  type ProviderMoney,
} from '@poe-worksmith/domain';
import { z } from 'zod';

import type { PoeTradeFetch } from './poeTrade.js';

const currencyLineSchema = z
  .object({
    chaosEquivalent: z.number().finite().positive().nullish(),
    currencyTypeName: z.string().min(1),
    detailsId: z.string().min(1),
  })
  .loose();
const currencyOverviewSchema = z
  .object({ lines: z.array(currencyLineSchema) })
  .loose();
const itemLineSchema = z
  .object({
    chaosValue: z.number().finite().positive().nullish(),
    detailsId: z.string().min(1),
    name: z.string().min(1),
  })
  .loose();
const itemOverviewSchema = z.object({ lines: z.array(itemLineSchema) }).loose();

const defaultBaseUrl = 'https://poe.ninja';
const defaultCacheTtlMs = 5 * 60 * 1000;
const defaultMaterials = {
  'divine-orb': {
    detailsId: 'divine-orb',
    overview: 'currency',
    type: 'Currency',
  },
  'large-cluster-jewel': {
    detailsId: 'large-cluster-jewel',
    overview: 'item',
    type: 'BaseType',
  },
  'primal-crystallised-lifeforce': {
    detailsId: 'primal-crystallised-lifeforce',
    overview: 'currency',
    type: 'Currency',
  },
} as const satisfies Record<string, PoeNinjaMaterialDefinition>;
const defaultCurrencyAliases = {
  chaos: 'chaos-orb',
  'chaos-orb': 'chaos-orb',
  divine: 'divine-orb',
  'divine-orb': 'divine-orb',
} as const;

export type PoeNinjaMaterialDefinition = Readonly<{
  detailsId: string;
  overview: 'currency' | 'item';
  type: string;
}>;

type OverviewLine = Readonly<{
  chaosAmount: number | null;
  detailsId: string;
  name: string;
}>;

type OverviewSnapshot = Readonly<{
  fetchedAt: Date;
  lines: readonly OverviewLine[];
}>;

type CachedOverview = {
  expiresAt: number;
  promise: Promise<OverviewSnapshot>;
};

export class PoeNinjaPriceProvider
  implements MaterialPriceProvider, CurrencyRateProvider
{
  readonly id = 'poe-ninja';
  readonly #baseUrl: URL;
  readonly #cache = new Map<string, CachedOverview>();
  readonly #cacheTtlMs: number;
  readonly #clock: () => Date;
  readonly #currencyAliases: ReadonlyMap<string, string>;
  readonly #fetch: PoeTradeFetch;
  readonly #materials: ReadonlyMap<string, PoeNinjaMaterialDefinition>;
  readonly #userAgent: string;

  constructor(options: {
    baseUrl?: string;
    cacheTtlMs?: number;
    clock?: () => Date;
    currencies?: Readonly<Record<string, string>>;
    fetch?: PoeTradeFetch;
    materials?: Readonly<Record<string, PoeNinjaMaterialDefinition>>;
    userAgent: string;
  }) {
    this.#baseUrl = new URL(options.baseUrl ?? defaultBaseUrl);
    this.#cacheTtlMs = options.cacheTtlMs ?? defaultCacheTtlMs;
    if (!Number.isInteger(this.#cacheTtlMs) || this.#cacheTtlMs <= 0) {
      throw new TypeError('cacheTtlMs must be a positive integer');
    }
    this.#clock = options.clock ?? (() => new Date());
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#userAgent = options.userAgent.trim();
    if (this.#userAgent.length === 0) {
      throw new TypeError('userAgent must not be empty');
    }
    this.#materials = canonicalMap({
      ...defaultMaterials,
      ...options.materials,
    });
    this.#currencyAliases = canonicalMap({
      ...defaultCurrencyAliases,
      ...options.currencies,
    });
  }

  async getPrice(request: MaterialPriceRequest): Promise<MaterialPriceQuote> {
    const materialKey = canonicalKey(request.materialKey);
    const definition = this.#materials.get(materialKey);
    if (!definition) throw new DomainError('UNKNOWN_MATERIAL');

    const overview = await this.#getOverview(
      request.league,
      definition.overview,
      definition.type,
    );
    const line = overview.lines.find(
      (candidate) => candidate.detailsId === definition.detailsId,
    );
    if (!line || line.chaosAmount === null) {
      throw new DomainError('MATERIAL_PRICE_MISSING');
    }

    const chaosAmount = formatDecimal(line.chaosAmount);
    return {
      chaosAmount,
      fetchedAt: overview.fetchedAt,
      materialKey,
      original: { amount: chaosAmount, currency: 'chaos' },
      provider: this.id,
    };
  }

  async getRate(request: CurrencyRateRequest): Promise<CurrencyRateQuote> {
    const fromCurrency = canonicalKey(request.fromCurrency);
    const toCurrency = canonicalKey(request.toCurrency);
    if (fromCurrency === toCurrency) {
      return {
        fetchedAt: this.#clock(),
        fromCurrency,
        provider: this.id,
        rate: '1',
        toCurrency,
      };
    }

    const overview = await this.#getOverview(
      request.league,
      'currency',
      'Currency',
    );
    const fromChaos = currencyChaosValue(
      fromCurrency,
      this.#currencyAliases,
      overview.lines,
    );
    const toChaos = currencyChaosValue(
      toCurrency,
      this.#currencyAliases,
      overview.lines,
    );

    return {
      fetchedAt: overview.fetchedAt,
      fromCurrency,
      provider: this.id,
      rate: formatDecimal(fromChaos / toChaos),
      toCurrency,
    };
  }

  async #getOverview(
    leagueInput: string,
    overview: 'currency' | 'item',
    type: string,
  ) {
    const league = leagueInput.trim();
    if (league.length === 0 || type.trim().length === 0) {
      throw new DomainError('MARKET_QUERY_INVALID');
    }
    const cacheKey = `${canonicalKey(league)}\u0000${overview}\u0000${type}`;
    const now = this.#clock().getTime();
    const cached = this.#cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.promise;

    const promise = this.#fetchOverview(league, overview, type).catch(
      (error: unknown) => {
        this.#cache.delete(cacheKey);
        throw error;
      },
    );
    this.#cache.set(cacheKey, {
      expiresAt: now + this.#cacheTtlMs,
      promise,
    });
    return promise;
  }

  async #fetchOverview(
    league: string,
    overview: 'currency' | 'item',
    type: string,
  ): Promise<OverviewSnapshot> {
    const path =
      overview === 'currency'
        ? '/poe1/api/economy/stash/current/currency/overview'
        : '/poe1/api/economy/stash/current/item/overview';
    const url = new URL(path, this.#baseUrl);
    url.searchParams.set('league', league);
    url.searchParams.set('type', type);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': this.#userAgent,
        },
        method: 'GET',
      });
    } catch (error) {
      throw new DomainError('PROVIDER_UNAVAILABLE', { cause: error });
    }
    if (!response.ok) throw mapHttpError(response.status);

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new DomainError('PROVIDER_RESPONSE_INVALID', { cause: error });
    }

    if (overview === 'currency') {
      const parsed = parseResponse(currencyOverviewSchema, body);
      return {
        fetchedAt: this.#clock(),
        lines: parsed.lines.map((line) => ({
          chaosAmount: line.chaosEquivalent ?? null,
          detailsId: line.detailsId,
          name: line.currencyTypeName,
        })),
      };
    }
    const parsed = parseResponse(itemOverviewSchema, body);
    return {
      fetchedAt: this.#clock(),
      lines: parsed.lines.map((line) => ({
        chaosAmount: line.chaosValue ?? null,
        detailsId: line.detailsId,
        name: line.name,
      })),
    };
  }
}

export type StaticMaterialDefinition = Readonly<{
  original: ProviderMoney | null;
  updatedAt: Date;
}>;

export class StaticPriceProvider
  implements MaterialPriceProvider, CurrencyRateProvider
{
  readonly id: string;
  readonly #materials: ReadonlyMap<string, StaticMaterialDefinition>;
  readonly #ratesToChaos: ReadonlyMap<string, number>;
  readonly #ratesUpdatedAt: Date;

  constructor(options: {
    id?: string;
    materials: Readonly<Record<string, StaticMaterialDefinition>>;
    ratesToChaos: Readonly<Record<string, number | string>>;
    ratesUpdatedAt: Date;
  }) {
    this.id = options.id ?? 'static-prices';
    this.#materials = canonicalMap(options.materials);
    this.#ratesToChaos = new Map(
      Object.entries({ chaos: 1, ...options.ratesToChaos }).map(
        ([currency, rate]) => {
          const parsed = Number(rate);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new TypeError(`Invalid chaos rate for ${currency}`);
          }
          return [canonicalKey(currency), parsed] as const;
        },
      ),
    );
    if (Number.isNaN(options.ratesUpdatedAt.getTime())) {
      throw new TypeError('ratesUpdatedAt must be a valid date');
    }
    this.#ratesUpdatedAt = options.ratesUpdatedAt;
  }

  async getPrice(request: MaterialPriceRequest): Promise<MaterialPriceQuote> {
    const materialKey = canonicalKey(request.materialKey);
    const definition = this.#materials.get(materialKey);
    if (!definition) throw new DomainError('UNKNOWN_MATERIAL');
    if (!definition.original) {
      throw new DomainError('MATERIAL_PRICE_MISSING');
    }
    const amount = Number(definition.original.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new DomainError('MATERIAL_PRICE_MISSING');
    }
    const rate = this.#rateToChaos(definition.original.currency);

    return {
      chaosAmount: formatDecimal(amount * rate),
      fetchedAt: definition.updatedAt,
      materialKey,
      original: definition.original,
      provider: this.id,
    };
  }

  async getRate(request: CurrencyRateRequest): Promise<CurrencyRateQuote> {
    const fromCurrency = canonicalKey(request.fromCurrency);
    const toCurrency = canonicalKey(request.toCurrency);
    return {
      fetchedAt: this.#ratesUpdatedAt,
      fromCurrency,
      provider: this.id,
      rate: formatDecimal(
        this.#rateToChaos(fromCurrency) / this.#rateToChaos(toCurrency),
      ),
      toCurrency,
    };
  }

  #rateToChaos(currency: string) {
    const rate = this.#ratesToChaos.get(canonicalKey(currency));
    if (rate === undefined) throw new DomainError('UNSUPPORTED_CURRENCY');
    return rate;
  }
}

function currencyChaosValue(
  currency: string,
  aliases: ReadonlyMap<string, string>,
  lines: readonly OverviewLine[],
) {
  if (currency === 'chaos' || currency === 'chaos-orb') return 1;
  const detailsId = aliases.get(currency) ?? currency;
  const line = lines.find((candidate) => candidate.detailsId === detailsId);
  if (!line || line.chaosAmount === null) {
    throw new DomainError('UNSUPPORTED_CURRENCY');
  }
  return line.chaosAmount;
}

function canonicalMap<T>(source: Readonly<Record<string, T>>) {
  return new Map(
    Object.entries(source).map(([key, value]) => [canonicalKey(key), value]),
  );
}

export function canonicalMaterialKey(value: string) {
  return canonicalKey(value);
}

function canonicalKey(value: string) {
  const key = value
    .trim()
    .toLocaleLowerCase('en')
    .replace(/[\s_]+/g, '-');
  if (key.length === 0) throw new TypeError('Canonical key must not be empty');
  return key;
}

function formatDecimal(value: number) {
  if (!Number.isFinite(value)) {
    throw new DomainError('CALCULATION_INPUT_INVALID');
  }
  return Number(value.toFixed(12)).toString();
}

function parseResponse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
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
