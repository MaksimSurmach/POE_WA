import {
  recipeTrendResponseSchema,
  trendOverviewResponseSchema,
  trendRangeSchema,
  type RecipeTrend,
  type TrendOverview,
  type TrendRange,
  type TrendSummary,
} from '@poe-worksmith/contracts';
import { DomainError, type Repositories } from '@poe-worksmith/domain';
import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Logger } from 'pino';

import {
  priceHistoryRanges,
  priceHistoryWindow,
  type PriceHistoryRepository,
  type PriceHistorySummary,
} from './repositories/priceHistoryRepository.js';

export type MarketTrendsOptions = {
  history: Pick<PriceHistoryRepository, 'readBuckets' | 'readSummaries'>;
  recipes: Pick<Repositories['recipes'], 'findById' | 'listActive'>;
  findCurrentLeague: Repositories['leagues']['findCurrent'];
  clock?: () => Date;
};

const recipeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function parseTrendRange(value: unknown): TrendRange {
  if (value === undefined) return '7d';
  const parsed = trendRangeSchema.safeParse(value);
  if (!parsed.success) throw new DomainError('MARKET_QUERY_INVALID');
  return parsed.data;
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Change uses the first and last independent observations in the window only. */
export function toTrendSummary(summary: PriceHistorySummary): TrendSummary {
  const window = summary.window;
  const from = window ? Number(window.open) : 0;
  const to = window ? Number(window.close) : 0;
  const change =
    window &&
    window.observations >= 2 &&
    window.firstObservedAt.getTime() < window.lastObservedAt.getTime()
      ? {
          from,
          fromObservedAt: window.firstObservedAt.toISOString(),
          to,
          toObservedAt: window.lastObservedAt.toISOString(),
          absolute: round(to - from, 8),
          percent: from > 0 ? round(((to - from) / from) * 100, 2) : null,
        }
      : null;
  return {
    currency: summary.latest.currency,
    latestAsk: Number(summary.latest.ask),
    latestObservedAt: summary.latest.observedAt.toISOString(),
    latestComparableSellers: summary.latest.comparableSellers,
    latestCoverage: summary.latest.coverage,
    latestCraftCost:
      summary.latest.craftCost === null
        ? null
        : Number(summary.latest.craftCost),
    latestCraftCostObservedAt:
      summary.latest.craftCostObservedAt?.toISOString() ?? null,
    windowObservations: window?.observations ?? 0,
    windowFirstObservedAt: window?.firstObservedAt.toISOString() ?? null,
    windowLastObservedAt: window?.lastObservedAt.toISOString() ?? null,
    change,
    excludedCurrencies: summary.excludedCurrencies,
  };
}

function windowFields(range: TrendRange, now: Date) {
  const window = priceHistoryWindow(range, now);
  return {
    range,
    bucketSeconds: priceHistoryRanges[range].bucketMs / 1000,
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    priceBasis: 'asking' as const,
    salesVolume: 'unknown' as const,
  };
}

export function createMarketTrendsReader(options: MarketTrendsOptions) {
  const clock = options.clock ?? (() => new Date());
  return {
    async readOverview(range: TrendRange): Promise<TrendOverview> {
      const now = clock();
      const [league, recipes] = await Promise.all([
        options.findCurrentLeague(),
        options.recipes.listActive(),
      ]);
      const base = windowFields(range, now);
      if (!league)
        return { ...base, state: 'unavailable', league: null, entries: [] };
      const summaries = await options.history.readSummaries({
        leagueId: league.id,
        range,
        now,
      });
      const entries = recipes
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((recipe) => {
          const summary = summaries.get(recipe.id);
          return {
            recipeId: recipe.id,
            title: recipe.title,
            category: recipe.category,
            summary: summary ? toTrendSummary(summary) : null,
          };
        });
      return {
        ...base,
        state: summaries.size ? 'available' : 'empty',
        league: { id: league.id, name: league.name },
        entries,
      };
    },
    async readRecipe(
      recipeId: string,
      range: TrendRange,
    ): Promise<RecipeTrend> {
      if (!recipeIdPattern.test(recipeId))
        throw new DomainError('MARKET_QUERY_INVALID');
      const now = clock();
      const [league, recipe] = await Promise.all([
        options.findCurrentLeague(),
        options.recipes.findById(recipeId),
      ]);
      if (!recipe || !recipe.active)
        throw new DomainError('PERSISTENCE_NOT_FOUND');
      const base = {
        ...windowFields(range, now),
        recipeId: recipe.id,
        title: recipe.title,
      };
      if (!league)
        return {
          ...base,
          state: 'unavailable',
          league: null,
          summary: null,
          buckets: [],
        };
      const summary = (
        await options.history.readSummaries({
          leagueId: league.id,
          range,
          now,
          recipeId: recipe.id,
        })
      ).get(recipe.id);
      const buckets = summary
        ? await options.history.readBuckets({
            leagueId: league.id,
            recipeId: recipe.id,
            currency: summary.latest.currency,
            range,
            now,
          })
        : [];
      return {
        ...base,
        state: summary ? 'available' : 'empty',
        league: { id: league.id, name: league.name },
        summary: summary ? toTrendSummary(summary) : null,
        buckets: buckets.map((bucket) => ({
          start: bucket.start.toISOString(),
          firstObservedAt: bucket.firstObservedAt.toISOString(),
          lastObservedAt: bucket.lastObservedAt.toISOString(),
          open: Number(bucket.open),
          high: Number(bucket.high),
          low: Number(bucket.low),
          close: Number(bucket.close),
          observations: bucket.observations,
          craftCost:
            bucket.craftCost === null ? null : Number(bucket.craftCost),
          craftCostObservedAt:
            bucket.craftCostObservedAt?.toISOString() ?? null,
          minComparableSellers: bucket.minComparableSellers,
          lastComparableSellers: bucket.lastComparableSellers,
        })),
      };
    },
  };
}

export type MarketTrendsReader = ReturnType<typeof createMarketTrendsReader>;

export function registerMarketTrendsRoutes(
  api: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  reader: MarketTrendsReader | undefined,
) {
  if (!reader) return;
  api.get<{ Querystring: { range?: unknown } }>(
    '/api/trends',
    async (request) =>
      trendOverviewResponseSchema.parse({
        correlationId: request.id,
        data: await reader.readOverview(parseTrendRange(request.query.range)),
      }),
  );
  api.get<{ Params: { recipeId: string }; Querystring: { range?: unknown } }>(
    '/api/trends/:recipeId',
    async (request) =>
      recipeTrendResponseSchema.parse({
        correlationId: request.id,
        data: await reader.readRecipe(
          request.params.recipeId,
          parseTrendRange(request.query.range),
        ),
      }),
  );
}
