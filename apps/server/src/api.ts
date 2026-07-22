import { randomUUID, timingSafeEqual } from 'node:crypto';

import {
  apiErrorEnvelopeSchema,
  type CatalogResponse,
  catalogResponseSchema,
  correlationIdSchema,
  rateLimitDiagnosticsResponseSchema,
  leaguesResponseSchema,
  currentLeagueResponseSchema,
  refreshDiagnosticsResponseSchema,
  type RecipeResponse,
  recipeResponseSchema,
  refreshProgressResponseSchema,
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
    diagnosticsToken?: string | undefined;
    readCircuits?: (() => Promise<ProviderCircuitState[]>) | undefined;
    readOperationalDiagnostics?: OperationalDiagnosticsReader | undefined;
    metrics?: { contentType: string; metrics(): Promise<string> } | undefined;
    readRefreshFreshness?: RefreshFreshnessReader | undefined;
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
  });

  api.setErrorHandler((error, request, reply) => {
    const domainError =
      error instanceof DomainError
        ? (error as AnyDomainError)
        : new DomainError('INTERNAL_ERROR', { cause: error });
    request.log.error({ err: error }, 'Request failed');
    const envelope = apiErrorEnvelopeSchema.parse({
      correlationId: request.id,
      error: serializeDomainError(domainError),
    });
    return reply.code(httpStatus(domainError)).send(envelope);
  });
  api.setNotFoundHandler(async () => {
    throw new DomainError('ROUTE_NOT_FOUND');
  });

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
        cron: '0 */4 * * *',
        timezone: 'UTC',
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
          nextScheduledAt: freshness.schedule.nextScheduledAt.toISOString(),
          timezone: freshness.schedule.timezone,
        },
        serverTime: freshness.serverTime.toISOString(),
        state: freshness.state,
      },
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
  if (error.code === 'OPERATOR_AUTH_REQUIRED') return 401;
  if (
    error.code === 'JOB_CONFLICT' ||
    error.code === 'PERSISTENCE_CONFLICT' ||
    error.code === 'PUBLICATION_CONFLICT' ||
    error.code === 'REFRESH_ALREADY_RUNNING'
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
