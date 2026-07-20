import Fastify from 'fastify';
import type { Logger } from 'pino';

export type ReadinessProbe = () => Promise<void>;

export function buildApi(logger: Logger, checkReadiness: ReadinessProbe) {
  const api = Fastify({ loggerInstance: logger });

  api.get('/health/live', async () => ({ status: 'ok' }));
  api.get('/health/ready', async (_request, reply) => {
    try {
      await checkReadiness();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not_ready' });
    }
  });

  return api;
}
