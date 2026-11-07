import { registerIntelligenceRoutes } from './intelligenceApi.js';
import type { IntelligenceService } from './intelligence.js';
import { registerFactoryRoutes } from './factoryApi.js';
import type { FactoryService } from './factory.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { registerCraftAnalysisRoutes } from './craftAnalysisApi.js';
import type { CraftAnalysisService } from './craftAnalysis.js';
import { isLocalAdmin, needsAdminAccess } from './adminAccess.js';
import {
  registerMarketAdminRoutes,
  type MarketAdminApiOptions,
} from './marketAdminApi.js';

import {
  apiErrorEnvelopeSchema,
  type CatalogResponse,
  catalogResponseSchema,
  correlationIdSchema,
  rateLimitDiagnosticsResponseSchema,
  leaguesResponseSchema,
  currentLeagueResponseSchema,
  refreshTriggerResponseSchema,
  refreshDiagnosticsResponseSchema,
  type RecipeResponse,
  recipeResponseSchema,
  refreshProgressResponseSchema,
  craftingPricesResponseSchema,
} from '@poe-worksmith/contracts';
import {
  type CatalogProgress,
  type AnyDomainError,
  DomainError,
  type RateLimitState,
  type ProviderCircuitState,
  type OperationalDiagnosticsSnapshot,
  type RefreshCycle,
  type PoeLeague,
  serializeDomainError,
} from '@poe-worksmith/domain';
import Fastify from 'fastify';
import type { Logger } from 'pino';
import {
  createRefreshFreshnessReader,
  type RefreshFreshness,
} from './freshness.js';
import { registerMarketResearchRoutes } from './marketResearchApi.js';
import type { MarketResearchRepository } from './marketResearch.js';
import { registerMarketEconomyRoutes } from './marketEconomyApi.js';
import {
  registerMarketTrendsRoutes,
  type MarketTrendsReader,
} from './marketTrendsApi.js';
import type { MarketEconomyOptions } from './marketEconomy.js';
import { readCraftingPrices } from './craftingPrices.js';
import type {
  MarketCollectionManager,
  MarketCollectionStore,
} from './marketCollection.js';

export type ReadinessProbe = () => Promise<void>;
export type RefreshProgressReader = () => Promise<CatalogProgress>;
export type RefreshFreshnessReader = () => Promise<RefreshFreshness>;
export type RateLimitDiagnosticsReader = () => Promise<RateLimitState[]>;
export type CatalogReader = (correlationId: string) => Promise<CatalogResponse>;
export type RecipeReader = (
  correlationId: string,
  recipeId: string,
) => Promise<RecipeResponse>;
export type LeagueReader = () => Promise<PoeLeague[]>;
export type CurrentLeagueReader = () => Promise<PoeLeague | null>;
export type OperationalDiagnosticsReader = (input: {
  recentCycles: number;
  recentFailures: number;
}) => Promise<OperationalDiagnosticsSnapshot>;

export function buildApi(
  logger: Logger,
  checkReadiness: ReadinessProbe,
  readRefreshProgress: RefreshProgressReader,
  readRateLimits: RateLimitDiagnosticsReader = async () => [],
  readCatalog?: CatalogReader,
  readRecipe?: RecipeReader,
  readLeagues?: LeagueReader,
  readCurrentLeague?: CurrentLeagueReader,
  options: {
    marketAdmin?: MarketAdminApiOptions | undefined;
    craftAnalysis?: CraftAnalysisService | undefined;
    factory?: FactoryService | undefined;
    intelligence?: IntelligenceService | undefined;
    diagnosticsToken?: string | undefined;
    readCircuits?: (() => Promise<ProviderCircuitState[]>) | undefined;
    readOperationalDiagnostics?: OperationalDiagnosticsReader | undefined;
    metrics?: { contentType: string; metrics(): Promise<string> } | undefined;
    readRefreshFreshness?: RefreshFreshnessReader | undefined;
    marketResearch?: MarketResearchRepository | undefined;
    marketCollection?:
      | { manager: MarketCollectionManager; store: MarketCollectionStore }
      | undefined;
    marketEconomy?: MarketEconomyOptions | undefined;
    marketTrends?: MarketTrendsReader | undefined;
    triggerRefresh?: (() => Promise<string | null>) | undefined;
  } = {},
) {
  const api = Fastify({
    genReqId(request) {
      const supplied = request.headers['x-request-id'];
      return typeof supplied === 'string' &&
        correlationIdSchema.safeParse(supplied).success
        ? supplied
        : randomUUID();
    },
    loggerInstance: logger,
  });

  api.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    const path = request.routeOptions.url ?? request.url.split('?')[0] ?? '';
    if (needsAdminAccess(request.method, path) && !isLocalAdmin(request))
      throw new DomainError('OPERATOR_AUTH_REQUIRED');
    if (path.startsWith('/api/admin/'))
      reply.header('cache-control', 'no-store');
    if (
      options.marketAdmin &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      (path.startsWith('/api/market/') || path === '/api/refresh')
    )
      await options.marketAdmin.store.audit(
        request.id,
        'legacy.write.request',
        { method: request.method, path },
      );
    if (
      options.marketAdmin &&
      request.method === 'POST' &&
      /\/api\/market\/(?:economy\/collect|snapshots\/import|targets\/[^/]+\/collection\/run)$/.test(
        path,
      )
    ) {
      const settings = (await options.marketAdmin.store.read()).effective;
      if (settings.collectionsPaused)
        throw new DomainError('MARKET_COLLECTION_PAUSED');
      if (!settings.manualRefreshEnabled)
        throw new DomainError('MARKET_ACCESS_BLOCKED');
    }
  });
  api.addHook('onResponse', async (request, reply) => {
    if (
      options.marketAdmin &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      (request.url.startsWith('/api/market/') ||
        request.url.split('?')[0] === '/api/refresh')
    )
      await options.marketAdmin.store.audit(request.id, 'legacy.write', {
        method: request.method,
        path: request.routeOptions.url,
        statusCode: reply.statusCode,
      });
  });

  api.setErrorHandler((error, request, reply) => {
    if (
      (request.url.startsWith('/api/market') ||
        request.url.startsWith('/api/admin/')) &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      [
        'FST_ERR_CTP_BODY_TOO_LARGE',
        'FST_ERR_CTP_INVALID_JSON_BODY',
        'FST_ERR_CTP_EMPTY_JSON_BODY',
        'FST_ERR_CTP_INVALID_MEDIA_TYPE',
      ].includes(String(error.code))
    ) {
      const invalid = new DomainError(
        request.url.startsWith('/api/admin/')
          ? 'MARKET_QUERY_INVALID'
          : 'MARKET_IMPORT_INVALID',
      );
      return reply
        .code(error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 413 : 400)
        .send(
          apiErrorEnvelopeSchema.parse({
            correlationId: request.id,
            error: serializeDomainError(invalid),
          }),
        );
    }
    const domainError =
      error instanceof DomainError
        ? (error as AnyDomainError)
        : new DomainError('INTERNAL_ERROR', { cause: error });
    request.log.error({ err: error }, 'Request failed');
    const envelope = apiErrorEnvelopeSchema.parse({
      correlationId: request.id,
      error: serializeDomainError(domainError),
    });
    return reply
      .code(
        request.url.startsWith('/api/market/economy') &&
          domainError.code === 'PROVIDER_RATE_LIMITED'
          ? 429
          : httpStatus(domainError),
      )
      .send(envelope);
  });
  api.setNotFoundHandler(async () => {
    throw new DomainError('ROUTE_NOT_FOUND');
  });

  registerMarketResearchRoutes(
    api,
    options.marketResearch,
    Boolean(options.marketEconomy?.client),
    options.marketEconomy?.repository,
    options.marketCollection,
    readRateLimits,
  );
  registerMarketEconomyRoutes(api, options.marketEconomy);
  api.get('/api/crafting-prices', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const league = await readCurrentLeague?.();
    return craftingPricesResponseSchema.parse({
      correlationId: request.id,
      data: await readCraftingPrices({
        league: league?.gggId ?? null,
        repository: options.marketEconomy?.repository,
        now: new Date(),
        maximumAgeMs: options.marketAdmin
          ? (await options.marketAdmin.store.read()).effective.maximumQuoteAgeMs
          : 30 * 60_000,
      }),
    });
  });
  registerMarketAdminRoutes(api, options.marketAdmin);
  registerCraftAnalysisRoutes(api, options.craftAnalysis);
  registerFactoryRoutes(api, options.factory);
  registerIntelligenceRoutes(api, options.intelligence);
  registerMarketTrendsRoutes(api, options.marketTrends);

  api.get('/health/live', async (request) => ({
    correlationId: request.id,
    status: 'ok',
  }));
  api.get('/health/ready', async (request) => {
    try {
      await checkReadiness();
      return { correlationId: request.id, status: 'ready' };
    } catch (error) {
      throw new DomainError('PERSISTENCE_UNAVAILABLE', { cause: error });
    }
  });
  api.get('/api/refresh', async (request) => {
    const freshness = await (
      options.readRefreshFreshness ??
      createRefreshFreshnessReader({
        getProgress: readRefreshProgress,
        findLatestAttempt: async () => null,
        readSchedule: async () => ({
          cron: '0 * * * *',
          timezone: 'UTC',
          enabled: true,
        }),
      })
    )();
    return refreshProgressResponseSchema.parse({
      correlationId: request.id,
      data: {
        active: serializeCycle(freshness.active),
        lastAttempt: serializeCycle(freshness.lastAttempt),
        lastSuccessful: freshness.lastSuccessful && {
          cycleId: freshness.lastSuccessful.cycleId,
          publishedAt: freshness.lastSuccessful.publishedAt.toISOString(),
        },
        published: serializeCycle(freshness.published),
        schedule: {
          cron: freshness.schedule.cron,
          nextScheduledAt:
            freshness.schedule.nextScheduledAt?.toISOString() ?? null,
          timezone: freshness.schedule.timezone,
        },
        serverTime: freshness.serverTime.toISOString(),
        state: freshness.state,
      },
    });
  });
  const triggerRefresh = options.triggerRefresh;
  if (triggerRefresh)
    api.post('/api/refresh', async (request, reply) => {
      const progress = await readRefreshProgress();
      const jobId = progress.active ? null : await triggerRefresh();
      reply.code(202);
      return refreshTriggerResponseSchema.parse({
        correlationId: request.id,
        data: { accepted: jobId !== null },
      });
    });
  api.get('/api/diagnostics/rate-limits', async (request) => {
    const policies = await readRateLimits();
    return rateLimitDiagnosticsResponseSchema.parse({
      correlationId: request.id,
      data: { policies: policies.map(serializeRateLimitState) },
    });
  });
  if (options.diagnosticsToken && options.readOperationalDiagnostics) {
    api.get('/api/diagnostics/refresh', async (request) => {
      const authorization = request.headers.authorization;
      if (!isOperatorAuthorized(authorization, options.diagnosticsToken!))
        throw new DomainError('OPERATOR_AUTH_REQUIRED');
      const query = request.query as { cycles?: string; failures?: string };
      const cycles = boundedQueryValue(query.cycles, 10, 1, 50);
      const failures = boundedQueryValue(query.failures, 50, 1, 200);
      const [snapshot, circuits, rateLimits] = await Promise.all([
        options.readOperationalDiagnostics!({
          recentCycles: cycles,
          recentFailures: failures,
        }),
        options.readCircuits?.() ?? [],
        readRateLimits(),
      ]);
      return refreshDiagnosticsResponseSchema.parse({
        correlationId: request.id,
        data: {
          serverTime: new Date().toISOString(),
          cycles: snapshot.cycles.map(serializeDiagnosticCycle),
          evaluations: snapshot.evaluations.map(serializeDiagnosticEvaluation),
          jobs: snapshot.jobs.map(serializeDiagnosticJob),
          circuits,
          rateLimits: rateLimits.map(serializeRateLimitState),
        },
      });
    });
  }
  if (options.metrics)
    api.get('/metrics', async (_request, reply) =>
      reply
        .type(options.metrics!.contentType)
        .send(await options.metrics!.metrics()),
    );
  if (readCatalog) {
    api.get('/api/catalog', async (request) =>
      catalogResponseSchema.parse(await readCatalog(request.id)),
    );
  }
  if (readRecipe) {
    api.get<{ Params: { recipeId: string } }>(
      '/api/recipes/:recipeId',
      async (request) =>
        recipeResponseSchema.parse(
          await readRecipe(request.id, request.params.recipeId),
        ),
    );
  }
  if (readLeagues)
    api.get('/api/leagues', async (request) =>
      leaguesResponseSchema.parse({
        correlationId: request.id,
        data: (await readLeagues()).map(serializeLeague),
      }),
    );
  if (readCurrentLeague)
    api.get('/api/leagues/current', async (request) => {
      const league = await readCurrentLeague();
      if (!league) throw new DomainError('CURRENT_LEAGUE_UNRESOLVED');
      return currentLeagueResponseSchema.parse({
        correlationId: request.id,
        data: serializeLeague(league),
      });
    });

  return api;
}

function serializeLeague(league: PoeLeague) {
  return {
    createdAt: league.createdAt.toISOString(),
    endAt: league.endAt?.toISOString() ?? null,
    game: league.game,
    gggId: league.gggId,
    id: league.id,
    isCurrent: league.isCurrent,
    discovery:
      league.metadata.tradeObserved === true &&
      league.metadata.poeNinjaObserved === true
        ? ('confirmed' as const)
        : ('last-known' as const),
    name: league.name,
    realm: league.realm,
    startAt: league.startAt?.toISOString() ?? null,
    syncedAt: league.syncedAt.toISOString(),
    updatedAt: league.updatedAt.toISOString(),
  };
}

function serializeCycle(cycle: RefreshCycle | null) {
  if (!cycle) return null;
  return {
    completedQueries: cycle.completedQueries,
    completedRecipes: cycle.completedRecipes,
    failedQueries: cycle.failedQueries,
    failedRecipes: cycle.failedRecipes,
    finishedAt: cycle.finishedAt?.toISOString() ?? null,
    id: cycle.id,
    publishedAt: cycle.publishedAt?.toISOString() ?? null,
    requestedAt: cycle.requestedAt.toISOString(),
    startedAt: cycle.startedAt?.toISOString() ?? null,
    status: cycle.status,
    totalQueries: cycle.totalQueries,
    totalRecipes: cycle.totalRecipes,
  };
}

function serializeRateLimitState(state: RateLimitState) {
  return {
    blockedUntil: state.blockedUntil.toISOString(),
    endpoints: state.endpoints,
    lastResponseAt: state.lastResponseAt?.toISOString() ?? null,
    lastStatus: state.lastStatus,
    minimumDelayMs: state.minimumDelayMs,
    nextRequestAt: state.nextRequestAt.toISOString(),
    policy: state.policy,
    updatedAt: state.updatedAt.toISOString(),
    waitingUntil: new Date(
      Math.max(state.blockedUntil.getTime(), state.nextRequestAt.getTime()),
    ).toISOString(),
    windows: state.windows,
  };
}

function httpStatus(error: AnyDomainError) {
  if (error.code === 'INTERNAL_ERROR') return 500;
  if (error.code === 'PERSISTENCE_NOT_FOUND') return 404;
  if (error.code === 'ROUTE_NOT_FOUND') return 404;
  if (
    error.code === 'MARKET_TARGET_NOT_FOUND' ||
    error.code === 'MARKET_SNAPSHOT_NOT_FOUND'
  )
    return 404;
  if (error.code === 'OPERATOR_AUTH_REQUIRED') return 401;
  if (
    error.code === 'JOB_CONFLICT' ||
    error.code === 'PERSISTENCE_CONFLICT' ||
    error.code === 'PUBLICATION_CONFLICT' ||
    error.code === 'REFRESH_ALREADY_RUNNING' ||
    error.code === 'MARKET_COLLECTION_BUSY' ||
    error.code === 'MARKET_COLLECTION_PAUSED' ||
    error.code === 'MARKET_COLLECTION_NOT_RUNNING'
  ) {
    return 409;
  }
  return error.disposition === 'retryable' ? 503 : 400;
}

function isOperatorAuthorized(header: string | undefined, token: string) {
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const length = Math.max(supplied.length, token.length, 1);
  const left = Buffer.alloc(length);
  const right = Buffer.alloc(length);
  left.write(supplied);
  right.write(token);
  return supplied.length === token.length && timingSafeEqual(left, right);
}
function boundedQueryValue(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new DomainError('MARKET_QUERY_INVALID');
  return parsed;
}
function serializeDiagnosticCycle(
  value: OperationalDiagnosticsSnapshot['cycles'][number],
) {
  return {
    ...value,
    requestedAt: value.requestedAt.toISOString(),
    startedAt: value.startedAt?.toISOString() ?? null,
    finishedAt: value.finishedAt?.toISOString() ?? null,
    publishedAt: value.publishedAt?.toISOString() ?? null,
  };
}
function serializeDiagnosticEvaluation(
  value: OperationalDiagnosticsSnapshot['evaluations'][number],
) {
  return { ...value, evaluatedAt: value.evaluatedAt.toISOString() };
}
function serializeDiagnosticJob(
  value: OperationalDiagnosticsSnapshot['jobs'][number],
) {
  return { ...value, updatedAt: value.updatedAt.toISOString() };
}
