import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { DomainError } from '@poe-worksmith/domain';
import {
  opportunitiesResponseSchema,
  opportunityResponseSchema,
  liquidityResponseSchema,
  capitalPlanResponseSchema,
  signalHistoryResponseSchema,
} from '@poe-worksmith/contracts';
import type { IntelligenceService } from './intelligence.js';
export function registerIntelligenceRoutes(
  api: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression,
    Logger
  >,
  service?: IntelligenceService,
) {
  if (!service) return;
  api.addHook('onReady', async () => {
    service.start();
  });
  api.addHook('onClose', async () => {
    await service.close();
  });
  function league(query: unknown) {
    const value = z
      .object({ league: z.string().trim().min(1).max(200) })
      .safeParse(query);
    if (!value.success) throw new DomainError('MARKET_QUERY_INVALID');
    return value.data.league;
  }
  api.get('/api/admin/intelligence/opportunities', async (request) =>
    opportunitiesResponseSchema.parse({
      correlationId: request.id,
      data: await service.opportunities(league(request.query)),
    }),
  );
  api.get<{ Params: { id: string } }>(
    '/api/admin/intelligence/recipes/:id',
    async (request) =>
      opportunityResponseSchema.parse({
        correlationId: request.id,
        data: await service.opportunity(
          request.params.id,
          league(request.query),
        ),
      }),
  );
  api.get<{ Params: { id: string } }>(
    '/api/admin/intelligence/recipes/:id/liquidity',
    async (request) =>
      liquidityResponseSchema.parse({
        correlationId: request.id,
        data: (
          await service.opportunity(request.params.id, league(request.query))
        ).liquidity,
      }),
  );
  api.get<{ Params: { id: string } }>(
    '/api/admin/intelligence/recipes/:id/history',
    async (request) =>
      signalHistoryResponseSchema.parse({
        correlationId: request.id,
        data: await service.history(request.params.id, league(request.query)),
      }),
  );
  api.post(
    '/api/admin/intelligence/allocations',
    { bodyLimit: 16384 },
    async (request) =>
      capitalPlanResponseSchema.parse({
        correlationId: request.id,
        data: await service.allocate(request.body),
      }),
  );
  api.get<{ Params: { id: string } }>(
    '/api/admin/intelligence/allocations/:id',
    async (request) =>
      capitalPlanResponseSchema.parse({
        correlationId: request.id,
        data: await service.plan(request.params.id),
      }),
  );
}
