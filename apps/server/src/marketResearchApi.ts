import {
  beltPriceUpdateInputSchema,
  beltPriceUpdateSchema,
  beltPriceUpdatesResponseSchema,
  beltOpportunitiesResponseSchema,
  marketResearchSnapshotResponseSchema,
  marketSnapshotImportSchema,
  marketCollectionResponseSchema,
  marketCollectionSettingsInputSchema,
  marketCollectionSettingsResponseSchema,
  marketCollectionRunResponseSchema,
  marketTargetResponseSchema,
  marketWorkbenchResponseSchema,
} from '@poe-worksmith/contracts';
import { DomainError, type RateLimitState } from '@poe-worksmith/domain';
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
import { activeCatalogTargets, importMarketCatalog } from './marketCatalog.js';
import { generateMarketTradeQuery } from './marketTradeQuery.js';
import { evaluateBeltOpportunity } from './beltOpportunity.js';
import type { MarketEconomyRepository } from './marketEconomy.js';
import {
  compareMarketObservations,
  disabledMarketCollectionSource,
  type MarketCollectionManager,
  type MarketCollectionStore,
} from './marketCollection.js';

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
  collection?: {
    manager: MarketCollectionManager;
    store: MarketCollectionStore;
  },
  readRateLimits: () => Promise<RateLimitState[]> = async () => [],
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

  api.get<{ Querystring: { kind?: string; league?: string } }>(
    '/api/market/belt-opportunities',
    async (request) => {
      const kind = request.query.kind === 'demo' ? 'demo' : 'observed';
      const repo = requireRepository(repository);
      const [targets, summaries] = await persist(() =>
        Promise.all([repo.listTargets(), repo.listSnapshots()]),
      );
      const beltTargets = activeCatalogTargets(targets)
        .filter(
          (target) =>
            (target.slot.toLowerCase() === 'belt' || target.tradeSearch) &&
            (!request.query.league || target.league === request.query.league),
        )
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
            const opportunity = await evaluateBeltOpportunity(
              target,
              snapshot,
              economyRepository,
              Date.now(),
              update,
            );
            const observations = collection
              ? await collection.store.listObservations(target.id)
              : [];
            const compatible = observations.filter(
              (run) =>
                run.dataKind === kind &&
                run.currency === snapshot?.currency &&
                run.targetDigest === target.digest &&
                run.queryDigest === snapshot?.queryDigest,
            );
            const point =
              compatible.length >= 2
                ? compareMarketObservations(compatible).at(-1)
                : undefined;
            return {
              ...opportunity,
              supply: point
                ? {
                    newCount: point.newCount,
                    missingCount: point.missingCount,
                    restoredCount: point.restoredCount,
                    increasedCount: point.increasedCount ?? 0,
                    decreasedCount: point.decreasedCount ?? 0,
                    coverage: point.coverage ?? null,
                  }
                : null,
            };
          }),
        ),
      );
      opportunities.sort((a, b) =>
        a.calculation && b.calculation
          ? (a.confidence === b.confidence
              ? 0
              : a.confidence === 'MEDIUM'
                ? -1
                : 1) ||
            Number(b.calculation.roiPercent) -
              Number(a.calculation.roiPercent) ||
            (b.comparison?.independentSellers ?? 0) -
              (a.comparison?.independentSellers ?? 0) ||
            (a.supply?.newCount ?? 0) - (b.supply?.newCount ?? 0)
          : a.calculation
            ? -1
            : b.calculation
              ? 1
              : (b.comparison?.independentSellers ?? 0) -
                  (a.comparison?.independentSellers ?? 0) ||
                a.name.localeCompare(b.name),
      );
      return beltOpportunitiesResponseSchema.parse({
        correlationId: request.id,
        data: opportunities,
      });
    },
  );

  api.post<{ Querystring: { dryRun?: string } }>(
    '/api/market/catalog/import',
    { bodyLimit: MARKET_IMPORT_BODY_LIMIT },
    async (request) => ({
      correlationId: request.id,
      data: await persist(() =>
        importMarketCatalog(
          request.body,
          requireRepository(repository),
          request.query.dryRun === 'true',
        ),
      ),
    }),
  );

  api.get<{ Params: { id: string }; Querystring: { scope?: string } }>(
    '/api/market/targets/:id/trade-query',
    async (request) => {
      const target = await persist(() =>
        requireRepository(repository).findTarget(request.params.id),
      );
      if (!target) throw new DomainError('MARKET_TARGET_NOT_FOUND');
      const scope = z
        .enum(['strict', 'broad'])
        .optional()
        .safeParse(request.query.scope);
      if (!scope.success) throw new DomainError('MARKET_QUERY_INVALID');
      return {
        correlationId: request.id,
        data: generateMarketTradeQuery(target, scope.data),
      };
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
      if (
        parsed.data.finishingPrices &&
        Object.keys(parsed.data.finishingPrices).sort().join('|') !==
          (method.finishing ?? [])
            .map((entry) => entry.id)
            .sort()
            .join('|')
      )
        throw new DomainError('MARKET_IMPORT_INVALID');
      if (parsed.data.recoveryPrice && !method.baseFailurePolicy?.recoveryPrice)
        throw new DomainError('MARKET_IMPORT_INVALID');
      const entries = [
        parsed.data.basePrice,
        ...Object.values(parsed.data.materialPrices),
        ...Object.values(parsed.data.finishingPrices ?? {}),
        ...(parsed.data.recoveryPrice ? [parsed.data.recoveryPrice] : []),
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
      if (target.tradeSearch) generateMarketTradeQuery(target);
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

  api.get<{ Params: { id: string } }>(
    '/api/market/targets/:id/collection',
    async (request) => {
      const targetId = request.params.id;
      if (!z.uuid().safeParse(targetId).success)
        throw new DomainError('MARKET_TARGET_NOT_FOUND');
      const store = requireCollectionStore(collection?.store);
      const [settings, runs, observations] = await Promise.all([
        persist(() => store.findSettings(targetId)),
        persist(() => store.listRuns(targetId, 25)),
        persist(() => store.listObservations(targetId)),
      ]);
      const limits = await persist(readRateLimits);
      const cooldown = Math.max(
        0,
        ...limits
          .filter((limit) =>
            limit.endpoints.some(
              (endpoint) =>
                endpoint === 'trade-search' || endpoint === 'trade-fetch',
            ),
          )
          .flatMap((limit) => [
            limit.blockedUntil.getTime(),
            limit.nextRequestAt.getTime(),
          ]),
      );
      const groups = new Map<string, typeof observations>();
      for (const run of observations) {
        if (!run.currency) continue;
        const key = `${run.dataKind}:${run.currency}:${run.queryDigest}`;
        const group = groups.get(key) ?? [];
        group.push(run);
        groups.set(key, group);
      }
      for (const run of observations) {
        if (run.currency || run.status !== 'empty') continue;
        for (const [key, group] of groups) {
          if (
            key.startsWith(`${run.dataKind}:`) &&
            key.endsWith(`:${run.queryDigest}`)
          )
            group.push(run);
        }
      }
      return marketCollectionResponseSchema.parse({
        correlationId: request.id,
        data: {
          source:
            collection?.manager.source ??
            disabledMarketCollectionSource.descriptor,
          settings,
          cooldownUntil:
            cooldown > Date.now() ? new Date(cooldown).toISOString() : null,
          runs,
          series: [...groups].map(([key, observations]) => {
            const [dataKind, currency, queryDigest] = key.split(':') as [
              'observed' | 'demo',
              'chaos' | 'divine',
              string,
            ];
            return {
              dataKind,
              currency,
              queryDigest,
              points: compareMarketObservations(observations),
            };
          }),
          note: 'Снимок описывает только охват конкретного запроса. Исчезновение означает отсутствие в полном наблюдении, а не подтверждённую продажу.',
        },
      });
    },
  );

  api.put<{ Params: { id: string } }>(
    '/api/market/targets/:id/collection/settings',
    async (request) => {
      if (!z.uuid().safeParse(request.params.id).success)
        throw new DomainError('MARKET_TARGET_NOT_FOUND');
      const input = marketCollectionSettingsInputSchema.safeParse(request.body);
      if (!input.success)
        throw new DomainError('MARKET_COLLECTION_INVALID', {
          cause: input.error,
        });
      const manager = requireCollectionManager(collection?.manager);
      return marketCollectionSettingsResponseSchema.parse({
        correlationId: request.id,
        data: await persist(() =>
          manager.updateSettings(request.params.id, input.data),
        ),
      });
    },
  );

  api.post<{ Params: { id: string } }>(
    '/api/market/targets/:id/collection/run',
    async (request, reply) => {
      if (!z.uuid().safeParse(request.params.id).success)
        throw new DomainError('MARKET_TARGET_NOT_FOUND');
      const run = await persist(() =>
        requireCollectionManager(collection?.manager).runNow(request.params.id),
      );
      return reply.code(202).send(
        marketCollectionRunResponseSchema.parse({
          correlationId: request.id,
          data: run,
        }),
      );
    },
  );

  api.post<{ Params: { id: string } }>(
    '/api/market/collection/runs/:id/cancel',
    async (request) => {
      if (!z.uuid().safeParse(request.params.id).success)
        throw new DomainError('MARKET_COLLECTION_NOT_RUNNING');
      const run = await persist(() =>
        requireCollectionManager(collection?.manager).cancel(request.params.id),
      );
      return marketCollectionRunResponseSchema.parse({
        correlationId: request.id,
        data: run,
      });
    },
  );
}

function requireCollectionStore(
  store: MarketCollectionStore | undefined,
): MarketCollectionStore {
  if (!store) throw new DomainError('PERSISTENCE_UNAVAILABLE');
  return store;
}

function requireCollectionManager(
  manager: MarketCollectionManager | undefined,
): MarketCollectionManager {
  if (!manager) throw new DomainError('PERSISTENCE_UNAVAILABLE');
  return manager;
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
