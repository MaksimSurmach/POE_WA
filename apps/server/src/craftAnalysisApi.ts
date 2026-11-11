import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Logger } from 'pino';
import {
  craftAnalysisResponseSchema,
  craftModelResponseSchema,
  craftRiskResponseSchema,
} from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';
import { z } from 'zod';
import type { CraftAnalysisService } from './craftAnalysis.js';

export function registerCraftAnalysisRoutes(
  api: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression,
    Logger
  >,
  service?: CraftAnalysisService,
) {
  if (!service) return;
  api.addHook('onReady', async () => {
    service.start();
  });
  api.addHook('onClose', async () => {
    await service.close();
  });
  api.get<{ Params: { recipeId: string }; Querystring: { league?: unknown } }>(
    '/api/recipes/:recipeId/analysis',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const league = z
        .string()
        .trim()
        .min(1)
        .max(160)
        .optional()
        .safeParse(request.query.league);
      if (!league.success) throw new DomainError('MARKET_QUERY_INVALID');
      return craftAnalysisResponseSchema.parse({
        correlationId: request.id,
        data: await service.readAnalysis(
          request.params.recipeId,
          league.data,
          true,
        ),
      });
    },
  );
  api.post(
    '/api/admin/craft-analysis/models',
    { bodyLimit: 262144 },
    async (request) =>
      craftModelResponseSchema.parse({
        correlationId: request.id,
        data: await service.saveModel(request.body),
      }),
  );
  api.post(
    '/api/admin/craft-analysis/simulations',
    { bodyLimit: 4096 },
    async (request, reply) => {
      const data = await service.createSimulation(request.body);
      reply.code(202);
      return craftRiskResponseSchema.parse({ correlationId: request.id, data });
    },
  );
  api.get<{ Params: { id: string } }>(
    '/api/admin/craft-analysis/simulations/:id',
    async (request) =>
      craftRiskResponseSchema.parse({
        correlationId: request.id,
        data: await service.readSimulation(request.params.id),
      }),
  );
  api.post<{ Params: { id: string } }>(
    '/api/admin/craft-analysis/simulations/:id/cancel',
    { bodyLimit: 1024 },
    async (request) =>
      craftRiskResponseSchema.parse({
        correlationId: request.id,
        data: await service.cancelSimulation(request.params.id),
      }),
  );
}
