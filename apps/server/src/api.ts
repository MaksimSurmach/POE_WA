import { randomUUID } from 'node:crypto';

import {
  apiErrorEnvelopeSchema,
  correlationIdSchema,
  rateLimitDiagnosticsResponseSchema,
  refreshProgressResponseSchema,
} from '@poe-worksmith/contracts';
import {
  type CatalogProgress,
  type AnyDomainError,
  DomainError,
  type RateLimitState,
  type RefreshCycle,
  serializeDomainError,
} from '@poe-worksmith/domain';
import Fastify from 'fastify';
import type { Logger } from 'pino';

export type ReadinessProbe = () => Promise<void>;
export type RefreshProgressReader = () => Promise<CatalogProgress>;
export type RateLimitDiagnosticsReader = () => Promise<RateLimitState[]>;

export function buildApi(
  logger: Logger,
  checkReadiness: ReadinessProbe,
  readRefreshProgress: RefreshProgressReader,
  readRateLimits: RateLimitDiagnosticsReader = async () => [],
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
    const progress = await readRefreshProgress();
    return refreshProgressResponseSchema.parse({
      correlationId: request.id,
      data: {
        active: serializeCycle(progress.active),
        published: serializeCycle(progress.published),
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

  return api;
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
    error.code === 'JOB_CONFLICT' ||
    error.code === 'PERSISTENCE_CONFLICT' ||
    error.code === 'PUBLICATION_CONFLICT' ||
    error.code === 'REFRESH_ALREADY_RUNNING'
  ) {
    return 409;
  }
  return error.disposition === 'retryable' ? 503 : 400;
}
