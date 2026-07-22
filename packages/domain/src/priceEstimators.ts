import { DomainError } from './errors.js';
import type { MarketListing, ProviderMoney } from './marketProviders.js';
import type { CanonicalRecipeV1 } from './recipeSchema.js';

export type EstimatorConfiguration = CanonicalRecipeV1['estimator'];
export type EstimatorUnavailableReason =
  'insufficient_listings' | 'no_listings';

export type PriceEstimate = Readonly<{
  configuration: EstimatorConfiguration;
  id: string;
  label: string;
  price: ProviderMoney | null;
  reason: EstimatorUnavailableReason | null;
  requiredListings: number;
}>;

export type ListingAgeBuckets = Readonly<{
  atLeastSevenDays: number;
  oneDayToSevenDays: number;
  oneHourToOneDay: number;
  underOneHour: number;
}>;

export type MarketAggregation = Readonly<{
  ageBuckets: ListingAgeBuckets;
  cheapest: ProviderMoney | null;
  currency: string;
  estimators: readonly PriceEstimate[];
  listings: readonly MarketListing[];
  medianTopFive: ProviderMoney | null;
  medianTopTen: ProviderMoney | null;
  sampleSize: number;
  secondCheapest: ProviderMoney | null;
  thirdCheapest: ProviderMoney | null;
  totalListings: number;
}>;

export interface PriceEstimatorPlugin {
  readonly strategy: EstimatorConfiguration['strategy'];
  estimate(
    sortedPrices: readonly number[],
    configuration: EstimatorConfiguration,
  ): number;
  label(configuration: EstimatorConfiguration): string;
  requiredListings(configuration: EstimatorConfiguration): number;
}

const cheapestPlugin: PriceEstimatorPlugin = {
  strategy: 'cheapest',
  estimate: (prices) => prices[0]!,
  label: () => 'Cheapest',
  requiredListings: () => 1,
};

const nthCheapestPlugin: PriceEstimatorPlugin = {
  strategy: 'nth_cheapest',
  estimate: (prices, configuration) =>
    prices[requiredN(configuration, 'nth_cheapest') - 1]!,
  label: (configuration) =>
    `${ordinal(requiredN(configuration, 'nth_cheapest'))} cheapest`,
  requiredListings: (configuration) => requiredN(configuration, 'nth_cheapest'),
};

const medianTopNPlugin: PriceEstimatorPlugin = {
  strategy: 'median_top_n',
  estimate: (prices, configuration) =>
    median(prices.slice(0, requiredN(configuration, 'median_top_n'))),
  label: (configuration) =>
    `Median top ${requiredN(configuration, 'median_top_n')}`,
  requiredListings: (configuration) => requiredN(configuration, 'median_top_n'),
};

const meanTopNPlugin: PriceEstimatorPlugin = {
  strategy: 'mean_top_n',
  estimate: (prices, configuration) =>
    mean(prices.slice(0, requiredN(configuration, 'mean_top_n'))),
  label: (configuration) =>
    `Mean top ${requiredN(configuration, 'mean_top_n')}`,
  requiredListings: (configuration) => requiredN(configuration, 'mean_top_n'),
};

const percentilePlugin: PriceEstimatorPlugin = {
  strategy: 'percentile',
  estimate: (prices, configuration) =>
    percentile(prices, requiredPercentile(configuration)),
  label: (configuration) => `${requiredPercentile(configuration)}th percentile`,
  requiredListings: () => 1,
};

export const priceEstimatorPlugins: readonly PriceEstimatorPlugin[] = [
  cheapestPlugin,
  nthCheapestPlugin,
  medianTopNPlugin,
  meanTopNPlugin,
  percentilePlugin,
];

export const standardEstimatorConfigurations = [
  { strategy: 'cheapest' },
  { n: 2, strategy: 'nth_cheapest' },
  { n: 3, strategy: 'nth_cheapest' },
  { n: 5, strategy: 'median_top_n' },
  { n: 10, strategy: 'median_top_n' },
  { n: 5, strategy: 'mean_top_n' },
  { percentile: 50, strategy: 'percentile' },
] as const satisfies readonly EstimatorConfiguration[];

export function aggregateMarketListings(input: {
  currency: string;
  listings: readonly MarketListing[];
  totalListings?: number;
}): MarketAggregation {
  const currency = input.currency.trim();
  if (currency.length === 0) {
    throw new DomainError('CALCULATION_INPUT_INVALID');
  }
  const listings = deduplicateSellers(
    [...input.listings].sort(compareListings),
  );
  const prices = listings.map((listing) => parseListing(listing, currency));
  const totalListings = input.totalListings ?? listings.length;
  if (
    !Number.isInteger(totalListings) ||
    totalListings < listings.length ||
    totalListings < 0
  ) {
    throw new DomainError('CALCULATION_INPUT_INVALID');
  }
  const money = (value: number | undefined): ProviderMoney | null =>
    value === undefined ? null : { amount: formatPrice(value), currency };

  const base = {
    ageBuckets: ageBuckets(listings),
    cheapest: money(prices[0]),
    currency,
    listings,
    medianTopFive:
      prices.length >= 5 ? money(median(prices.slice(0, 5))) : null,
    medianTopTen:
      prices.length >= 10 ? money(median(prices.slice(0, 10))) : null,
    sampleSize: listings.length,
    secondCheapest: money(prices[1]),
    thirdCheapest: money(prices[2]),
    totalListings,
  };

  return {
    ...base,
    estimators: standardEstimatorConfigurations.map((configuration) =>
      estimateFromPrices(prices, currency, configuration),
    ),
  };
}

export function selectPriceEstimate(
  aggregation: MarketAggregation,
  configuration: EstimatorConfiguration,
  plugins: readonly PriceEstimatorPlugin[] = priceEstimatorPlugins,
) {
  const prices = aggregation.listings.map((listing) =>
    parseListing(listing, aggregation.currency),
  );
  return estimateFromPrices(
    prices,
    aggregation.currency,
    configuration,
    plugins,
  );
}

function estimateFromPrices(
  prices: readonly number[],
  currency: string,
  configuration: EstimatorConfiguration,
  plugins: readonly PriceEstimatorPlugin[] = priceEstimatorPlugins,
): PriceEstimate {
  const plugin = plugins.find(
    (candidate) => candidate.strategy === configuration.strategy,
  );
  if (!plugin) throw new DomainError('CALCULATION_INPUT_INVALID');
  const requiredListings = plugin.requiredListings(configuration);
  const id = estimatorId(configuration);
  const label = plugin.label(configuration);
  if (prices.length < requiredListings) {
    return {
      configuration,
      id,
      label,
      price: null,
      reason: prices.length === 0 ? 'no_listings' : 'insufficient_listings',
      requiredListings,
    };
  }

  return {
    configuration,
    id,
    label,
    price: {
      amount: formatPrice(plugin.estimate(prices, configuration)),
      currency,
    },
    reason: null,
    requiredListings,
  };
}

function compareListings(left: MarketListing, right: MarketListing) {
  const priceDifference =
    Number(left.price.amount) - Number(right.price.amount);
  if (priceDifference !== 0) return priceDifference;
  const idDifference = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  if (idDifference !== 0) return idDifference;
  const indexedDifference =
    left.indexedAt.getTime() - right.indexedAt.getTime();
  if (indexedDifference !== 0) return indexedDifference;
  return left.account < right.account
    ? -1
    : left.account > right.account
      ? 1
      : 0;
}

function deduplicateSellers(listings: readonly MarketListing[]) {
  const sellers = new Set<string>();
  return listings.filter((listing) => {
    if (sellers.has(listing.account)) return false;
    sellers.add(listing.account);
    return true;
  });
}

function parseListing(listing: MarketListing, currency: string) {
  if (listing.price.currency !== currency) {
    throw new DomainError('UNSUPPORTED_CURRENCY');
  }
  const price = Number(listing.price.amount);
  if (!Number.isFinite(price) || price < 0) {
    throw new DomainError('CALCULATION_INPUT_INVALID');
  }
  if (!Number.isInteger(listing.ageSeconds) || listing.ageSeconds < 0) {
    throw new DomainError('CALCULATION_INPUT_INVALID');
  }
  return price;
}

function ageBuckets(listings: readonly MarketListing[]): ListingAgeBuckets {
  const buckets = {
    atLeastSevenDays: 0,
    oneDayToSevenDays: 0,
    oneHourToOneDay: 0,
    underOneHour: 0,
  };
  for (const { ageSeconds } of listings) {
    if (ageSeconds < 60 * 60) buckets.underOneHour += 1;
    else if (ageSeconds < 24 * 60 * 60) buckets.oneHourToOneDay += 1;
    else if (ageSeconds < 7 * 24 * 60 * 60) buckets.oneDayToSevenDays += 1;
    else buckets.atLeastSevenDays += 1;
  }
  return buckets;
}

function median(values: readonly number[]) {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1]! + values[middle]!) / 2
    : values[middle]!;
}

function mean(values: readonly number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], requested: number) {
  const position = (requested / 100) * (values.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return values[lower]! + (values[upper]! - values[lower]!) * weight;
}

function requiredN(
  configuration: EstimatorConfiguration,
  strategy: 'mean_top_n' | 'median_top_n' | 'nth_cheapest',
) {
  if (configuration.strategy !== strategy) {
    throw new DomainError('CALCULATION_INPUT_INVALID');
  }
  if (!Number.isInteger(configuration.n) || configuration.n < 1) {
    throw new DomainError('CALCULATION_INPUT_INVALID');
  }
  return configuration.n;
}

function requiredPercentile(configuration: EstimatorConfiguration) {
  if (configuration.strategy !== 'percentile') {
    throw new DomainError('CALCULATION_INPUT_INVALID');
  }
  if (
    !Number.isFinite(configuration.percentile) ||
    configuration.percentile <= 0 ||
    configuration.percentile > 100
  ) {
    throw new DomainError('CALCULATION_INPUT_INVALID');
  }
  return configuration.percentile;
}

function estimatorId(configuration: EstimatorConfiguration) {
  switch (configuration.strategy) {
    case 'cheapest':
      return 'cheapest';
    case 'nth_cheapest':
      return `${configuration.n}-cheapest`;
    case 'median_top_n':
      return `median-top-${configuration.n}`;
    case 'mean_top_n':
      return `mean-top-${configuration.n}`;
    case 'percentile':
      return `percentile-${configuration.percentile}`;
  }
}

function ordinal(value: number) {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

function formatPrice(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    throw new DomainError('CALCULATION_FAILED');
  }
  return Number(value.toFixed(8)).toString();
}
