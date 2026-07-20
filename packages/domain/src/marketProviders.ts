export type CanonicalJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalJsonValue[]
  | CanonicalJsonObject;

export interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}

export type ProviderMoney = Readonly<{
  amount: string;
  currency: string;
}>;

export type MarketListing = Readonly<{
  account: string;
  ageSeconds: number;
  fee: ProviderMoney | null;
  id: string;
  indexedAt: Date;
  item: CanonicalJsonObject;
  price: ProviderMoney;
}>;

export type MarketSearchRequest = Readonly<{
  league: string;
  query: CanonicalJsonObject;
  schemaVersion: number;
}>;

export type MarketSearchResult = Readonly<{
  fetchedAt: Date;
  listings: readonly MarketListing[];
  provider: string;
  totalResults: number;
}>;

export interface MarketSearchProvider {
  readonly id: string;
  search(request: MarketSearchRequest): Promise<MarketSearchResult>;
}

export type MaterialPriceRequest = Readonly<{
  league: string;
  materialKey: string;
}>;

export type MaterialPriceQuote = Readonly<{
  chaosAmount: string;
  fetchedAt: Date;
  materialKey: string;
  original: ProviderMoney;
  provider: string;
}>;

export interface MaterialPriceProvider {
  readonly id: string;
  getPrice(request: MaterialPriceRequest): Promise<MaterialPriceQuote>;
}

export type CurrencyRateRequest = Readonly<{
  fromCurrency: string;
  league: string;
  toCurrency: string;
}>;

export type CurrencyRateQuote = Readonly<{
  fetchedAt: Date;
  fromCurrency: string;
  provider: string;
  rate: string;
  toCurrency: string;
}>;

export interface CurrencyRateProvider {
  readonly id: string;
  getRate(request: CurrencyRateRequest): Promise<CurrencyRateQuote>;
}

export type MarketQueryHashInput = Readonly<{
  league: string;
  provider: string;
  query: CanonicalJsonObject;
  schemaVersion: number;
}>;

const unorderedArrayKeys = new Set(['filters', 'have', 'stats', 'want']);

/**
 * Produces a stable, non-mutating representation of a provider query.
 * Object key order and the order of set-like filter collections are ignored.
 */
export function canonicalizeMarketQuery(
  query: CanonicalJsonObject,
): CanonicalJsonObject {
  const canonical = canonicalizeObject(query, new WeakSet());
  return canonical;
}

export function serializeMarketQuery(query: CanonicalJsonObject): string {
  return JSON.stringify(canonicalizeMarketQuery(query));
}

/** Hashes provider + league + query schema version + canonical query. */
export async function hashMarketQuery(
  input: MarketQueryHashInput,
): Promise<string> {
  const provider = requireIdentity('provider', input.provider);
  const league = requireIdentity('league', input.league);
  if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1) {
    throw new TypeError('schemaVersion must be a positive integer');
  }

  const payload = JSON.stringify({
    league,
    provider,
    query: canonicalizeMarketQuery(input.query),
    schemaVersion: input.schemaVersion,
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(payload),
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function canonicalizeObject(
  value: CanonicalJsonObject,
  ancestors: WeakSet<object>,
): CanonicalJsonObject {
  assertPlainObject(value);
  enter(value, ancestors);

  const entries: [string, CanonicalJsonValue][] = [];
  for (const key of Object.keys(value).sort()) {
    const child = canonicalizeValue(value[key], key, ancestors);
    if (isInsignificantDefault(key, child) || isEmptyContainer(child)) continue;
    entries.push([key, child]);
  }

  ancestors.delete(value);
  return Object.fromEntries(entries);
}

function canonicalizeValue(
  value: CanonicalJsonValue | undefined,
  key: string,
  ancestors: WeakSet<object>,
): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Market queries may only contain finite numbers');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    enter(value, ancestors);
    const canonical = value.map((child) =>
      canonicalizeValue(child, '', ancestors),
    );
    ancestors.delete(value);

    return unorderedArrayKeys.has(key)
      ? [...canonical].sort(compareCanonicalValues)
      : canonical;
  }
  if (typeof value === 'object') {
    return canonicalizeObject(value as CanonicalJsonObject, ancestors);
  }
  throw new TypeError('Market queries must contain JSON values only');
}

function compareCanonicalValues(
  left: CanonicalJsonValue,
  right: CanonicalJsonValue,
) {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function isInsignificantDefault(key: string, value: CanonicalJsonValue) {
  return key === 'disabled' && value === false;
}

function isEmptyContainer(value: CanonicalJsonValue) {
  return (
    (Array.isArray(value) && value.length === 0) ||
    (isPlainObject(value) && Object.keys(value).length === 0)
  );
}

function assertPlainObject(
  value: object,
): asserts value is CanonicalJsonObject {
  if (!isPlainObject(value)) {
    throw new TypeError('Market queries may only contain plain JSON objects');
  }
}

function isPlainObject(value: unknown): value is CanonicalJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function enter(value: object, ancestors: WeakSet<object>) {
  if (ancestors.has(value)) {
    throw new TypeError('Market queries cannot contain cycles');
  }
  ancestors.add(value);
}

function requireIdentity(name: string, value: string) {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} must not be empty`);
  return normalized;
}
