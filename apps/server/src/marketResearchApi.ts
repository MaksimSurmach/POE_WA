import {
  beltPriceUpdateInputSchema,
  beltPriceUpdateSchema,
  beltPriceUpdatesResponseSchema,
  beltOpportunitiesResponseSchema,
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
import { randomUUID } from 'node:crypto';

import { analyzeBeltSnapshot } from './beltComparability.js';
import { evaluateBeltOpportunity } from './beltOpportunity.js';
import type { MarketEconomyRepository } from './marketEconomy.js';

import {
  createImportedMarketSnapshot,
  createMarketTarget,
  MARKET_IMPORT_BODY_LIMIT,
  marketSourceCapabilities,
  marketDigest,
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
  economyRepository?: MarketEconomyRepository,
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

  api.get<{ Querystring: { kind?: string } }>(
    '/api/market/belt-opportunities',
    async (request) => {
      const kind = request.query.kind === 'demo' ? 'demo' : 'observed';
      const repo = requireRepository(repository);
      const [targets, summaries] = await persist(() =>
        Promise.all([repo.listTargets(), repo.listSnapshots()]),
      );
      const beltTargets = targets
        .filter((target) => target.slot.toLowerCase() === 'belt')
        .slice(0, 100);
      const opportunities = await persist(() =>
        Promise.all(
          beltTargets.map(async (target) => {
            const latest = summaries
              .filter(
                (snapshot) =>
                  snapshot.targetId === target.id &&
                  snapshot.targetDigest === target.digest &&
                  snapshot.dataKind === kind,
              )
              .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
            const snapshot = latest ? await repo.findSnapshot(latest.id) : null;
            if (latest && !snapshot) throw new Error('Snapshot unavailable');
            const updates = (await repo.listPriceUpdates?.(target.id)) ?? [];
            const update = updates.find(
              (entry) =>
                entry.targetDigest === target.digest && entry.dataKind === kind,
            );
            return evaluateBeltOpportunity(
              target,
              snapshot,
              economyRepository,
              Date.now(),
              update,
            );
          }),
        ),
      );
      opportunities.sort((a, b) =>
        a.calculation && b.calculation
          ? Number(b.calculation.spread) - Number(a.calculation.spread)
          : a.calculation
            ? -1
            : b.calculation
              ? 1
              : a.name.localeCompare(b.name),
      );
      return beltOpportunitiesResponseSchema.parse({
        correlationId: request.id,
        data: opportunities,
      });
    },
  );

  api.get<{ Params: { id: string } }>(
    '/api/market/targets/:id/belt-prices',
    async (request) => {
      if (!z.uuid().safeParse(request.params.id).success)
        throw new DomainError('MARKET_TARGET_NOT_FOUND');
      const repo = requireRepository(repository);
      if (!repo.listPriceUpdates)
        throw new DomainError('PERSISTENCE_UNAVAILABLE');
      return beltPriceUpdatesResponseSchema.parse({
        correlationId: request.id,
        data: await persist(() => repo.listPriceUpdates!(request.params.id)),
      });
    },
  );
  api.post(
    '/api/market/belt-prices',
    { bodyLimit: MARKET_IMPORT_BODY_LIMIT },
    async (request, reply) => {
      const parsed = beltPriceUpdateInputSchema.safeParse(request.body);
      if (!parsed.success)
        throw new DomainError('MARKET_IMPORT_INVALID', { cause: parsed.error });
      const repo = requireRepository(repository);
      if (!repo.savePriceUpdate)
        throw new DomainError('PERSISTENCE_UNAVAILABLE');
      const target = await persist(() => repo.findTarget(parsed.data.targetId));
      if (!target) throw new DomainError('MARKET_TARGET_NOT_FOUND');
      const method = target.beltCraftMethod;
      if (
        !method ||
        Object.keys(parsed.data.materialPrices).sort().join('|') !==
          method.materials
            .map((entry) => entry.id)
            .sort()
            .join('|')
      )
        throw new DomainError('MARKET_IMPORT_INVALID');
      const entries = [
        parsed.data.basePrice,
        ...Object.values(parsed.data.materialPrices),
      ];
      if (
        entries.some(
          (entry) =>
            entry.source === 'manual' &&
            (entry.dataKind !== parsed.data.dataKind ||
              entry.league !== target.league ||
              entry.patch !== target.patch ||
              Date.parse(entry.capturedAt) > Date.now()),
        )
      )
        throw new DomainError('MARKET_IMPORT_INVALID');
      const update = beltPriceUpdateSchema.parse({
        ...parsed.data,
        id: randomUUID(),
        targetDigest: target.digest,
        digest: marketDigest({
          version: 1,
          targetDigest: target.digest,
          ...parsed.data,
        }),
        createdAt: new Date().toISOString(),
      });
      const stored = await persist(() => repo.savePriceUpdate!(update));
      return reply
        .code(stored.id === update.id ? 201 : 200)
        .send({ correlationId: request.id, data: stored });
    },
  );

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

  api.get<{ Params: { id: string; version: string } }>(
    '/api/market/snapshots/:id/belt-analysis/:version',
    async (request) => {
      if (!z.uuid().safeParse(request.params.id).success)
        throw new DomainError('MARKET_SNAPSHOT_NOT_FOUND');
      const snapshot = await persist(() =>
        requireRepository(repository).findSnapshot(request.params.id),
      );
      if (!snapshot) throw new DomainError('MARKET_SNAPSHOT_NOT_FOUND');
      const target = await persist(() =>
        requireRepository(repository).findTarget(snapshot.targetId),
      );
      if (!target || target.digest !== snapshot.targetDigest)
        throw new DomainError('MARKET_TARGET_NOT_FOUND');
      if (request.params.version !== `v${target.beltRules?.version ?? 1}`)
        throw new DomainError('MARKET_SNAPSHOT_NOT_FOUND');
      return {
        correlationId: request.id,
        data: analyzeBeltSnapshot(target, snapshot),
      };
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
