import { marketAdminSettingsResponseSchema } from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';
import type {
  FastifyInstance,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { MarketAdminStore } from './marketAdmin.js';

export type MarketAdminApiOptions = {
  store: MarketAdminStore;
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
  const { store } = options;
  api.get('/api/admin/market/settings', async (request) => ({
    correlationId: request.id,
    data: marketAdminSettingsResponseSchema.parse(await store.read()),
  }));
  api.patch(
    '/api/admin/market/settings',
    { bodyLimit: 4096 },
    async (request) => {
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
}
