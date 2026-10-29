import {
  marketResearchSnapshotResponseSchema,
  marketSnapshotImportSchema,
  marketTargetResponseSchema,
  marketWorkbenchResponseSchema,
} from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';
import type {
  FastifyInstance,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';

import {
  createImportedMarketSnapshot,
  createMarketTarget,
  MARKET_IMPORT_BODY_LIMIT,
  marketSourceCapabilities,
  type MarketResearchRepository,
} from './marketResearch.js';

export function registerMarketResearchRoutes(
  api: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  repository?: MarketResearchRepository,
  economyConfigured = false,
) {
  const sources = marketSourceCapabilities.map((source) =>
    source.id === 'poe_ninja_economy' && economyConfigured
      ? {
          ...source,
          status: 'available' as const,
          description:
            'Manual public economy collection is configured. PostgreSQL must be ready before collection; the Sources panel shows saved observations and provider errors. Base estimates do not price arbitrary rare items.',
        }
      : source,
  );
  api.get('/api/market', async (request) => {
    const unavailable = () =>
      marketWorkbenchResponseSchema.parse({
        correlationId: request.id,
        data: {
          storage: 'unavailable',
          targets: [],
          snapshots: [],
          sources,
        },
      });
    if (!repository) return unavailable();
    try {
      const [targets, snapshots] = await Promise.all([
        repository.listTargets(),
        repository.listSnapshots(),
      ]);
      return marketWorkbenchResponseSchema.parse({
        correlationId: request.id,
        data: {
          storage: 'postgres',
          targets,
          snapshots,
          sources,
        },
      });
    } catch (error) {
      request.log.warn(
        { err: error },
        'Market research storage is unavailable',
      );
      return unavailable();
    }
  });

  api.post(
    '/api/market/targets',
    { bodyLimit: MARKET_IMPORT_BODY_LIMIT },
    async (request, reply) => {
      const target = createMarketTarget(request.body);
      const stored = await persist(() =>
        requireRepository(repository).saveTarget(target),
      );
      return reply.code(201).send(
        marketTargetResponseSchema.parse({
          correlationId: request.id,
          data: stored,
        }),
      );
    },
  );

  api.post(
    '/api/market/snapshots/import',
    { bodyLimit: MARKET_IMPORT_BODY_LIMIT },
    async (request, reply) => {
      const parsed = marketSnapshotImportSchema.safeParse(request.body);
      if (!parsed.success)
        throw new DomainError('MARKET_IMPORT_INVALID', { cause: parsed.error });
      const target = await persist(() =>
        requireRepository(repository).findTarget(parsed.data.targetId),
      );
      if (!target) throw new DomainError('MARKET_TARGET_NOT_FOUND');
      const snapshot = createImportedMarketSnapshot(parsed.data, target);
      const stored = await persist(() =>
        requireRepository(repository).saveSnapshot(snapshot),
      );
      return reply.code(stored.id === snapshot.id ? 201 : 200).send(
        marketResearchSnapshotResponseSchema.parse({
          correlationId: request.id,
          data: stored,
        }),
      );
    },
  );

  api.get<{ Params: { id: string } }>(
    '/api/market/snapshots/:id',
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
  repository: MarketResearchRepository | undefined,
): MarketResearchRepository {
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
