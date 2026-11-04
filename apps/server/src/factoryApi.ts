import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { DomainError, FactoryLedgerError } from '@poe-worksmith/domain';
import {
  factoryBatchResponseSchema,
  factoryBatchListResponseSchema,
  factorySummaryResponseSchema,
  factoryInventoryResponseSchema,
  factorySalesResponseSchema,
} from '@poe-worksmith/contracts';
import type { FactoryService } from './factory.js';

const querySchema = z.object({
  league: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
export function registerFactoryRoutes(
  api: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression,
    Logger
  >,
  service?: FactoryService,
) {
  if (!service) return;
  const query = (raw: unknown) => {
    const parsed = querySchema.safeParse(raw);
    if (!parsed.success) throw new DomainError('MARKET_QUERY_INVALID');
    return parsed.data;
  };
  const write = async <T>(work: () => Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof FactoryLedgerError) {
        const invalid = new DomainError('FACTORY_LEDGER_INVALID', {
          cause: error,
        });
        throw invalid;
      }
      throw error;
    }
  };
  api.post(
    '/api/admin/factory/batches',
    { bodyLimit: 16384 },
    async (request) =>
      factoryBatchResponseSchema.parse({
        correlationId: request.id,
        data: await write(() => service.create(request.body)),
      }),
  );
  api.get('/api/admin/factory/batches', async (request) => {
    const q = query(request.query);
    return factoryBatchListResponseSchema.parse({
      correlationId: request.id,
      data: await service.list(q.league, q.limit, q.offset),
    });
  });
  api.get<{ Params: { id: string } }>(
    '/api/admin/factory/batches/:id',
    async (request) =>
      factoryBatchResponseSchema.parse({
        correlationId: request.id,
        data: await service.get(request.params.id),
      }),
  );
  api.post<{ Params: { id: string } }>(
    '/api/admin/factory/batches/:id/events',
    { bodyLimit: 32768 },
    async (request) =>
      factoryBatchResponseSchema.parse({
        correlationId: request.id,
        data: await write(() =>
          service.append(request.params.id, request.body),
        ),
      }),
  );
  api.get('/api/admin/factory/summary', async (request) => {
    const q = query(request.query);
    return factorySummaryResponseSchema.parse({
      correlationId: request.id,
      data: await service.summary(q.league),
    });
  });
  api.get('/api/admin/factory/inventory', async (request) => {
    const q = query(request.query);
    return factoryInventoryResponseSchema.parse({
      correlationId: request.id,
      data: await service.inventory(q.league, q.limit, q.offset),
    });
  });
  api.get('/api/admin/factory/sales', async (request) => {
    const q = query(request.query);
    return factorySalesResponseSchema.parse({
      correlationId: request.id,
      data: await service.sales(q.league, q.limit, q.offset),
    });
  });
  api.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/api/admin/factory/batches/:id/export',
    async (request, reply) => {
      const format = z
        .enum(['csv', 'json'])
        .safeParse(request.query.format ?? 'json');
      if (!format.success) throw new DomainError('MARKET_QUERY_INVALID');
      const content = await service.export(request.params.id, format.data);
      reply.type(
        format.data === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/json; charset=utf-8',
      );
      reply.header(
        'content-disposition',
        `attachment; filename="factory-${request.params.id}.${format.data}"`,
      );
      return content;
    },
  );
}
