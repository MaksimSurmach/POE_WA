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
  marketCollectionRequestResponseSchema,
  marketCollectionRequestStatusResponseSchema,
  marketTargetResponseSchema,
  marketWorkbenchResponseSchema,
  scheduledTradeTrendResponseSchema,
  tradeDashboardRangeSchema,
  tradeDashboardResponseSchema,
  marketStarterLibraryResponseSchema,
  marketStarterMarketSnapshotSchema,
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
import { marketCollectionRunner } from './config.js';
import { parseTrendRange } from './marketTrendsApi.js';
import { priceHistoryRanges } from './repositories/priceHistoryRepository.js';

import { analyzeListingComparability } from './listingComparability.js';
import { activeCatalogTargets, importMarketCatalog } from './marketCatalog.js';
import { marketStarterLibrary } from './marketStarterLibrary.js';
import {
  generateMarketTradeQuery,
  marketTradeUrl,
} from './marketTradeQuery.js';
import { evaluateBeltOpportunity } from './beltOpportunity.js';
import type { MarketEconomyRepository } from './marketEconomy.js';
import { convertMarketQuote } from './marketCurrency.js';
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

const starterItems: Record<string, { iconUrl: string; type: string }> = {
  'Cloak of Flame': {
    iconUrl:
      'https://web.poecdn.com/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvQXJtb3Vycy9Cb2R5QXJtb3Vycy9Cb2R5SW50MUF1bmlxdWUiLCJ3IjoyLCJoIjozLCJzY2FsZSI6MX1d/41c15c6511/BodyInt1Aunique.png',
    type: 'Scholar’s Robe',
  },
  'Quill Rain': {
    iconUrl:
      'https://web.poecdn.com/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvV2VhcG9ucy9Ud29IYW5kV2VhcG9ucy9Cb3dzL0JvdzJ1bmlxdWUiLCJ3IjoyLCJoIjozLCJzY2FsZSI6MX1d/5c5cad82e8/Bow2unique.png',
    type: 'Short Bow',
  },
  'Replica Dragonfang’s Flight': {
    iconUrl:
      'https://web.poecdn.com/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvQW11bGV0cy9NYWxhY2hhaSdzIEJyaWxsaWFuY2VBbXVsZXQiLCJ3IjoxLCJoIjoxLCJzY2FsZSI6MX1d/a1548914e0/Malachai%27s%20BrillianceAmulet.png',
    type: 'Onyx Amulet',
  },
};
const uniqueStarterItems = new Set(Object.keys(starterItems));
const genericStarterBases = new Set(['Elder-influenced helmet', 'Helmet']);
function starterTradeUrl(baseTypes: string[], league: string) {
  const item = baseTypes.find((baseType) => uniqueStarterItems.has(baseType));
  const baseType = item
    ? starterItems[item]?.type
    : baseTypes.length === 1
      ? baseTypes[0]
      : null;
  if (!baseType || (!item && genericStarterBases.has(baseType))) return null;
  const unique = Boolean(item);
  const query = {
    query: {
      status: { option: 'online' },
      ...(item
        ? {
            name: item.replace(/[’‘]/g, "'"),
            type: baseType.replace(/[’‘]/g, "'"),
          }
        : { type: baseType.replace(/[’‘]/g, "'") }),
      stats: [{ type: 'and', filters: [] }],
      filters: {
        type_filters: {
          filters: { rarity: { option: unique ? 'unique' : 'nonunique' } },
        },
      },
    },
    sort: { price: 'asc' },
  };
  return marketTradeUrl(league, query);
}

type StarterSnapshot = {
  snapshot: NonNullable<Awaited<ReturnType<MarketEconomyRepository['find']>>>;
  summary: Awaited<ReturnType<MarketEconomyRepository['list']>>[number];
};
const starterSnapshotCache = new WeakMap<
  MarketEconomyRepository,
  Map<string, StarterSnapshot>
>();

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
  api.get('/api/market/starter-library', async (request) => {
    const repositoryCache: Map<string, StarterSnapshot> = economyRepository
      ? (starterSnapshotCache.get(economyRepository) ??
        new Map<string, StarterSnapshot>())
      : new Map<string, StarterSnapshot>();
    if (economyRepository && !starterSnapshotCache.has(economyRepository))
      starterSnapshotCache.set(economyRepository, repositoryCache);
    const latestByLeague = new Map(repositoryCache);
    if (economyRepository) {
      await Promise.all(
        [...new Set(marketStarterLibrary.map((target) => target.league))].map(
          async (league) => {
            try {
              const summary = await economyRepository.latest(
                league,
                'BaseType',
              );
              if (!summary) {
                latestByLeague.delete(league);
                repositoryCache.delete(league);
                return;
              }
              const cached = latestByLeague.get(league);
              if (cached?.summary.id === summary.id) return;
              const snapshot = await economyRepository.find(summary.id);
              if (!snapshot) {
                latestByLeague.delete(league);
                repositoryCache.delete(league);
                return;
              }
              const entry = { snapshot, summary };
              const current = repositoryCache.get(league);
              const currentIsNewer =
                current &&
                (current.summary.capturedAt > summary.capturedAt ||
                  (current.summary.capturedAt === summary.capturedAt &&
                    current.summary.id < summary.id));
              if (currentIsNewer) {
                latestByLeague.set(league, current);
                return;
              }
              latestByLeague.set(league, entry);
              repositoryCache.set(league, entry);
            } catch (error) {
              latestByLeague.delete(league);
              repositoryCache.delete(league);
              request.log.warn(
                { err: error, league },
                'Could not read the latest BaseType snapshot for one league',
              );
            }
          },
        ),
      );
    }
    return marketStarterLibraryResponseSchema.parse({
      correlationId: request.id,
      data: marketStarterLibrary.map((target) => {
        const latest = latestByLeague.get(target.league);
        const latestBaseTypes = latest?.snapshot;
        const summary = latest?.summary;
        const baseType =
          target.baseTypes.length === 1
            ? target.baseTypes[0]?.trim().toLowerCase()
            : null;
        const lines = baseType
          ? (latestBaseTypes?.lines.filter(
              (entry) =>
                entry.baseType?.trim().toLowerCase() === baseType ||
                entry.name?.trim().toLowerCase() === baseType,
            ) ?? [])
          : [];
        const uniqueLine = lines.length === 1 ? lines[0] : null;
        // Item-level and influence variants are not a price for the unqualified base.
        const exactBaseLine =
          uniqueLine?.detailsId === baseTypeSlug(target.baseTypes[0] ?? '');
        const marketSnapshot =
          lines.length && latestBaseTypes && summary
            ? marketStarterMarketSnapshotSchema.safeParse({
                capturedAt: latestBaseTypes.capturedAt,
                iconUrl: lines.find((entry) => entry.iconUrl)?.iconUrl ?? null,
                league: latestBaseTypes.league,
                listingCount: sumCounts(lines.map((line) => line.listingCount)),
                observationCount: sumCounts(
                  lines.map((line) => line.observationCount),
                ),
                price: {
                  amount: exactBaseLine
                    ? (uniqueLine?.price.amount ?? null)
                    : null,
                  currency: uniqueLine?.price.currency ?? 'chaos',
                },
                sourceUrl: summary.endpoint,
                variantCount: lines.length,
              })
            : null;
        if (marketSnapshot && !marketSnapshot.success)
          request.log.warn(
            { issues: marketSnapshot.error.issues },
            'Ignoring invalid BaseType snapshot data for the starter library',
          );
        return {
          ...target,
          artworkUrl:
            target.baseTypes
              .map((baseType) => starterItems[baseType]?.iconUrl)
              .find(Boolean) ?? null,
          marketSnapshot: marketSnapshot?.success ? marketSnapshot.data : null,
          tradeUrl: starterTradeUrl(target.baseTypes, target.league),
        };
      }),
    });
  });

  api.get<{ Querystring: { range?: string; target?: string } }>(
    '/api/market/trade-trends',
    async (request, reply) => {
      const range = parseTrendRange(request.query.range);
      const target = z.uuid().optional().safeParse(request.query.target);
      if (!target.success) throw new DomainError('MARKET_QUERY_INVALID');
      if (!repository?.readScheduledTradeTrend)
        throw new DomainError('PERSISTENCE_UNAVAILABLE');
      const end = new Date();
      const start = new Date(end.getTime() - priceHistoryRanges[range].rangeMs);
      const data = await persist(() =>
        repository.readScheduledTradeTrend!(start, end, target.data),
      );
      reply.header('cache-control', 'no-store');
      return scheduledTradeTrendResponseSchema.parse({
        correlationId: request.id,
        data: {
          ...data,
          range,
          windowStart: start.toISOString(),
          windowEnd: end.toISOString(),
        },
      });
    },
  );

  for (const path of ['/api/trade-history', '/api/market/trade-dashboard']) {
    api.get<{
      Querystring: { range?: string; league?: string; target?: string };
    }>(path, async (request, reply) => {
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
          (item) =>
            item.latest?.currency === 'chaos' && item.latest.ask !== null,
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
                if (
                  item.latest?.currency !== 'chaos' ||
                  item.latest.ask === null
                )
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
  }

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
                  snapshot.dataKind === kind &&
                  (kind === 'demo' || snapshot.coverage === 'complete'),
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
      if (snapshot.rawAvailable === false)
        throw new DomainError('MARKET_SNAPSHOT_NOT_FOUND');
      const target = await persist(() =>
        requireRepository(repository).findTarget(snapshot.targetId),
      );
      if (!target || target.digest !== snapshot.targetDigest)
        throw new DomainError('MARKET_TARGET_NOT_FOUND');
      if (request.params.version !== `v${target.beltRules?.version ?? 1}`)
        throw new DomainError('MARKET_SNAPSHOT_NOT_FOUND');
      return {
        correlationId: request.id,
        data: analyzeListingComparability(target, snapshot),
      };
    },
  );

  for (const path of [
    '/api/trade-history/snapshots/:id',
    '/api/market/snapshots/:id',
  ]) {
    api.get<{ Params: { id: string } }>(path, async (request) => {
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
    });
  }

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

  api.get<{ Params: { id: string } }>(
    '/api/market/collection/requests/:id',
    async (request) => {
      if (!z.uuid().safeParse(request.params.id).success)
        throw new DomainError('MARKET_COLLECTION_NOT_RUNNING');
      const result = await requireCollectionManager(
        collection?.manager,
      ).findRequest(request.params.id);
      if (!result) throw new DomainError('MARKET_COLLECTION_NOT_RUNNING');
      return marketCollectionRequestStatusResponseSchema.parse({
        correlationId: request.id,
        data: result,
      });
    },
  );

  api.get<{ Params: { id: string } }>(
    '/api/market/collection/runs/:id',
    async (request) => {
      if (!z.uuid().safeParse(request.params.id).success)
        throw new DomainError('MARKET_COLLECTION_NOT_RUNNING');
      const run = await requireCollectionManager(collection?.manager).findRun(
        request.params.id,
      );
      if (!run) throw new DomainError('MARKET_COLLECTION_NOT_RUNNING');
      return marketCollectionRunResponseSchema.parse({
        correlationId: request.id,
        data: run,
      });
    },
  );

  api.post<{ Params: { id: string } }>(
    '/api/market/targets/:id/collection/run',
    async (request, reply) => {
      if (!z.uuid().safeParse(request.params.id).success)
        throw new DomainError('MARKET_TARGET_NOT_FOUND');
      const manager = requireCollectionManager(collection?.manager);
      if (marketCollectionRunner() === 'go') {
        const requestId = await persist(() =>
          manager.enqueueRequest(request.params.id, null),
        );
        return reply.code(202).send(
          marketCollectionRequestResponseSchema.parse({
            correlationId: request.id,
            data: { requestId, status: 'queued' },
          }),
        );
      }
      const run = await persist(() => manager.runNow(request.params.id));
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
      if (marketCollectionRunner() === 'go')
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

function sumCounts(counts: (number | null)[]) {
  return counts.reduce<number | null>(
    (total, count) => (count === null ? total : (total ?? 0) + count),
    null,
  );
}

function baseTypeSlug(baseType: string) {
  return baseType
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
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
