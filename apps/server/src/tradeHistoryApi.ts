import {
  marketResearchSnapshotResponseSchema,
  tradeDashboardRangeSchema,
  tradeDashboardResponseSchema,
} from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';
import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { convertMarketQuote } from './marketCurrency.js';
import type { MarketEconomyRepository } from './marketEconomy.js';
import type { MarketResearchRepository } from './marketResearch.js';
import { priceHistoryRanges } from './repositories/priceHistoryRepository.js';

export type TradeHistoryRepository = Pick<
  MarketResearchRepository,
  'findSnapshot' | 'readTradeDashboard'
>;

export function registerTradeHistoryRoutes(
  api: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  repository?: TradeHistoryRepository,
  economyRepository?: MarketEconomyRepository,
) {
  api.get<{
    Querystring: { range?: string; league?: string; target?: string };
  }>('/api/trade-history', async (request, reply) => {
    const query = z
      .object({
        range: tradeDashboardRangeSchema.default('24h'),
        league: z.string().trim().min(1).max(100).optional(),
        target: z.uuid().optional(),
      })
      .safeParse(request.query);
    if (!query.success) throw new DomainError('MARKET_QUERY_INVALID');
    if (!repository?.readTradeDashboard)
      throw new DomainError('PERSISTENCE_UNAVAILABLE');
    const { range, league, target } = query.data;
    const end = new Date();
    const start = new Date(end.getTime() - priceHistoryRanges[range].rangeMs);
    const data = await persist(() =>
      repository.readTradeDashboard!(start, end, league, target),
    );
    const exchange =
      !target &&
      economyRepository &&
      data.league &&
      data.items.some(
        (item) => item.latest?.currency === 'chaos' && item.latest.ask !== null,
      )
        ? await economyRepository
            .latest(data.league, 'Currency')
            .then((summary) =>
              summary?.priceBasis === 'currency-exchange'
                ? economyRepository.find(summary.id)
                : null,
            )
            .catch((error: unknown) => {
              request.log.warn(
                { err: error },
                'Trade chart exchange observation unavailable',
              );
              return null;
            })
        : null;
    const dashboardLeague = data.league;
    const items =
      exchange && dashboardLeague
        ? await Promise.all(
            data.items.map(async (item) => {
              if (item.latest?.currency !== 'chaos' || item.latest.ask === null)
                return item;
              const quote = await convertMarketQuote({
                money: { amount: String(item.latest.ask), currency: 'chaos' },
                currency: 'divine',
                target: { league: dashboardLeague },
                capturedAt: item.latest.at,
                exchangeSnapshotId: exchange.id,
                economy: { find: async () => exchange },
                now: end.getTime(),
                dataKind: 'observed',
              });
              return quote
                ? { ...item, chartAskDivine: Number(quote.money.amount) }
                : item;
            }),
          )
        : data.items;
    reply.header('cache-control', 'no-store');
    return tradeDashboardResponseSchema.parse({
      correlationId: request.id,
      data: {
        ...data,
        items,
        range,
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
      },
    });
  });

  api.get<{ Params: { id: string } }>(
    '/api/trade-history/snapshots/:id',
    async (request) => {
      if (!z.uuid().safeParse(request.params.id).success)
        throw new DomainError('MARKET_SNAPSHOT_NOT_FOUND');
      const snapshot = await persist(() =>
        requireRepository(repository).findSnapshot(request.params.id),
      );
      if (!snapshot) throw new DomainError('MARKET_SNAPSHOT_NOT_FOUND');
      return marketResearchSnapshotResponseSchema.parse({
        correlationId: request.id,
        data: snapshot,
      });
    },
  );
}

function requireRepository(
  repository: TradeHistoryRepository | undefined,
): TradeHistoryRepository {
  if (!repository) throw new DomainError('PERSISTENCE_UNAVAILABLE');
  return repository;
}

async function persist<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('PERSISTENCE_UNAVAILABLE', { cause: error });
  }
}
