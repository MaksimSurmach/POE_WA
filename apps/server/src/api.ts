import { randomUUID } from 'node:crypto';

import {
  apiErrorEnvelopeSchema,
  correlationIdSchema,
} from '@poe-worksmith/contracts';
import {
  type AnyDomainError,
  DomainError,
  serializeDomainError,
} from '@poe-worksmith/domain';
import Fastify from 'fastify';
import type { Logger } from 'pino';

export type ReadinessProbe = () => Promise<void>;

export function buildApi(logger: Logger, checkReadiness: ReadinessProbe) {
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

  return api;
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
