import {
  marketEconomyCollectInputSchema,
  marketEconomyCollectResponseSchema,
  marketEconomyOverviewResponseSchema,
  marketEconomyLeaguesResponseSchema,
  marketEconomyDetailResponseSchema,
} from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';
import type {
  FastifyInstance,
  FastifyReply,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { NinjaEconomyError } from './providers/ninjaEconomy.js';
import {
  newStoredEconomySnapshot,
  previewEconomy,
  type MarketEconomyOptions,
} from './marketEconomy.js';

export function registerMarketEconomyRoutes(
  api: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  options: MarketEconomyOptions = {},
) {
  api.get('/api/market/economy', async (request) => {
    let storage: 'postgres' | 'unavailable' = 'unavailable';
    let snapshots: Awaited<
      ReturnType<NonNullable<MarketEconomyOptions['repository']>['list']>
    > = [];
    if (options.repository) {
      try {
        snapshots = await options.repository.list();
        storage = 'postgres';
      } catch (error) {
        request.log.warn(
          { err: error },
          'Economy snapshot storage unavailable',
        );
      }
    }
    return marketEconomyOverviewResponseSchema.parse({
      correlationId: request.id,
      data: {
        configured: Boolean(options.client),
        storage,
        snapshots,
        limit: 100,
      },
    });
  });
  api.get('/api/market/economy/leagues', async (request, reply) => {
    if (!options.client) throw new DomainError('ECONOMY_NOT_CONFIGURED');
    if (!options.repository) throw new DomainError('PERSISTENCE_UNAVAILABLE');
    await storageCall(() => options.repository!.assertReady());
    const result = await providerCall(
      () => options.client!.discoverLeagues(),
      reply,
    );
    return marketEconomyLeaguesResponseSchema.parse({
      correlationId: request.id,
      data: {
        leagues: result.snapshot.leagues,
        checkedAt: result.checkedAt,
        nextRefreshAt: result.nextRefreshAt,
      },
    });
  });
  api.post(
    '/api/market/economy/collect',
    { bodyLimit: 4096 },
    async (request, reply) => {
      const parsed = marketEconomyCollectInputSchema.safeParse(request.body);
      if (!parsed.success) throw new DomainError('MARKET_QUERY_INVALID');
      if (!options.client) throw new DomainError('ECONOMY_NOT_CONFIGURED');
      if (!options.repository) throw new DomainError('PERSISTENCE_UNAVAILABLE');
      await storageCall(() => options.repository!.assertReady());
      const result = await providerCall(
        () => options.client!.fetchSnapshot(parsed.data),
        reply,
      );
      if (!result.archiveAllowed)
        throw new DomainError('ECONOMY_ARCHIVE_DISALLOWED');
      const stored = await storageCall(() =>
        options.repository!.save(newStoredEconomySnapshot(result.snapshot)),
      );
      return marketEconomyCollectResponseSchema.parse({
        correlationId: request.id,
        data: {
          snapshot: previewEconomy(stored),
          cacheStatus: result.cacheStatus,
          checkedAt: result.checkedAt,
          nextRefreshAt: result.nextRefreshAt,
        },
      });
    },
  );
  api.get<{ Params: { id: string } }>(
    '/api/market/economy/:id',
    async (request) => {
      if (!z.uuid().safeParse(request.params.id).success)
        throw new DomainError('MARKET_SNAPSHOT_NOT_FOUND');
      if (!options.repository) throw new DomainError('PERSISTENCE_UNAVAILABLE');
      const snapshot = await storageCall(() =>
        options.repository!.find(request.params.id),
      );
      if (!snapshot) throw new DomainError('MARKET_SNAPSHOT_NOT_FOUND');
      return marketEconomyDetailResponseSchema.parse({
        correlationId: request.id,
        data: previewEconomy(snapshot),
      });
    },
  );
}
async function storageCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new DomainError('PERSISTENCE_UNAVAILABLE', { cause });
  }
}
async function providerCall<T>(
  operation: () => Promise<T>,
  reply: FastifyReply,
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (!(cause instanceof NinjaEconomyError)) throw cause;
    if (cause.retryAt)
      reply.header('retry-after', new Date(cause.retryAt).toUTCString());
    if (cause.code === 'INVALID_REQUEST')
      throw new DomainError('MARKET_QUERY_INVALID', { cause });
    if (cause.code === 'SCHEMA_INVALID')
      throw new DomainError('PROVIDER_SCHEMA_CHANGED', { cause });
    if (cause.code === 'RATE_LIMITED' || cause.code === 'COOLDOWN')
      throw new DomainError('PROVIDER_RATE_LIMITED', { cause });
    throw new DomainError('PROVIDER_UNAVAILABLE', { cause });
  }
}
