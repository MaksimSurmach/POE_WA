import {
  marketAdminStatusSchema,
  marketAdminSettingsResponseSchema,
  marketAdminPatchSchema,
  marketAdminSettingsSchema,
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
import { isLocalAdmin } from './adminAccess.js';
import type { MarketAdminStore, AdminQueue } from './marketAdmin.js';
import type { MarketAdminStatus } from '@poe-worksmith/contracts';

const operatorSettingsPatch = marketAdminPatchSchema.extend({
  settings: marketAdminSettingsSchema
    .pick({ maximumQuoteAgeMs: true, freshnessWarningMs: true })
    .partial(),
});

export type MarketAdminApiOptions = {
  store: MarketAdminStore;
  queue?: AdminQueue | undefined;
  status(): Promise<MarketAdminStatus>;
};
export function registerMarketAdminRoutes(
  api: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  options?: MarketAdminApiOptions,
) {
  if (!options) return;
  const { store, queue } = options;
  api.get('/api/admin/market/settings', async (request) => ({
    correlationId: request.id,
    data: marketAdminSettingsResponseSchema.parse(await store.read()),
  }));
  api.patch(
    '/api/admin/market/settings',
    { bodyLimit: 4096 },
    async (request) => {
      if (
        !isLocalAdmin(request) &&
        !operatorSettingsPatch.safeParse(request.body).success
      )
        throw new DomainError('MARKET_QUERY_INVALID');
      return {
        correlationId: request.id,
        data: await store.patch(request.body, request.id),
      };
    },
  );
  for (const action of ['pause', 'resume'] as const)
    api.post(
      `/api/admin/market/${action}`,
      { bodyLimit: 1024 },
      async (request) => {
        const parsed = z
          .strictObject({ version: z.number().int().nonnegative() })
          .safeParse(request.body);
        if (!parsed.success) throw new DomainError('MARKET_QUERY_INVALID');
        return {
          correlationId: request.id,
          data: await store.patch(
            {
              version: parsed.data.version,
              settings: { collectionsPaused: action === 'pause' },
            },
            request.id,
            `collection.${action}`,
          ),
        };
      },
    );
  if (!queue) return;
  api.get('/api/admin/market/status', async (request) => ({
    correlationId: request.id,
    data: marketAdminStatusSchema.parse(await options.status()),
  }));
  api.post(
    '/api/admin/market/refresh',
    { bodyLimit: 1024 },
    async (request, reply) => {
      const result = await store.enqueue(request.body, request.id, queue);
      return reply.code(202).send({ correlationId: request.id, data: result });
    },
  );
  api.get('/api/admin/market/runs', async (request) => ({
    correlationId: request.id,
    data: await store.runs(),
  }));
  api.post<{ Params: { id: string } }>(
    '/api/admin/market/runs/:id/cancel',
    { bodyLimit: 1024 },
    async (request, reply) => {
      if (!z.uuid().safeParse(request.params.id).success)
        throw new DomainError('MARKET_QUERY_INVALID');
      return reply.code(202).send({
        correlationId: request.id,
        data: await store.cancel(request.params.id, request.id, queue),
      });
    },
  );
}
