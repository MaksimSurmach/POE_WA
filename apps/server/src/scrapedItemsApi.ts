import {
  scrapedItemBasesResponseSchema,
  scrapedItemCaptureResponseSchema,
  scrapedItemLinkInputSchema,
  scrapedItemModifiersResponseSchema,
  scrapedItemRejectionSchema,
  scrapedItemRevisionInputSchema,
  scrapedItemSaveInputSchema,
  scrapedItemsResponseSchema,
  scrapedItemTestResponseSchema,
  scrapedItemTestStartResponseSchema,
  scrapedItemWriteResponseSchema,
  type ScrapedItemDiagnostic,
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

import {
  ScrapedItemRejected,
  zodDiagnostics,
  type ScrapedItemService,
} from './scrapedItems.js';

const idParams = z.strictObject({ id: z.uuid() });
const testParams = z.strictObject({ id: z.uuid(), requestId: z.uuid() });
const unlinkParams = z.strictObject({
  id: z.uuid(),
  recipeId: z.string().min(1).max(200),
});
const modifierQuery = z.strictObject({
  q: z.string().trim().min(2).max(100),
  gameDataVersion: z.string().trim().min(1).max(100).optional(),
});
const basesQuery = z.strictObject({
  gameDataVersion: z.string().trim().min(1).max(100),
});
const unlinkQuery = z.strictObject({
  expectedRevision: z.coerce.number().int().min(1),
});

export const scrapedItemsPath = '/api/settings/scraped-items';

export function registerScrapedItemRoutes(
  api: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  service?: ScrapedItemService,
) {
  if (!service) return;

  /** Anything that is not a domain failure keeps the shared error envelope. */
  const parse = <T extends z.ZodType>(schema: T, value: unknown) => {
    const result = schema.safeParse(value);
    if (!result.success) throw new DomainError('MARKET_QUERY_INVALID');
    return result.data as z.output<T>;
  };
  const rejection = (
    correlationId: string,
    diagnostics: readonly ScrapedItemDiagnostic[],
  ) =>
    scrapedItemRejectionSchema.parse({
      correlationId,
      data: { diagnostics, status: 'rejected' },
    });
  /** Field-level problems in a body are reported as fixable diagnostics. */
  const parseBody = <T extends z.ZodType>(
    schema: T,
    value: unknown,
  ): z.output<T> => {
    const result = schema.safeParse(value);
    if (result.success) return result.data as z.output<T>;
    throw new ScrapedItemRejected(zodDiagnostics(result.error));
  };
  async function rejectable<T>(
    request: { id: string },
    reply: { code(status: number): unknown },
    work: () => Promise<T>,
  ) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof ScrapedItemRejected)) throw error;
      reply.code(422);
      return rejection(request.id, error.diagnostics);
    }
  }

  api.get(scrapedItemsPath, async (request) =>
    scrapedItemsResponseSchema.parse({
      correlationId: request.id,
      data: await service.list(),
    }),
  );

  api.get(`${scrapedItemsPath}/modifiers`, async (request) => {
    const query = parse(modifierQuery, request.query);
    return scrapedItemModifiersResponseSchema.parse({
      correlationId: request.id,
      data: await service.searchModifiers(query.q, query.gameDataVersion),
    });
  });

  api.get(`${scrapedItemsPath}/bases`, async (request) => {
    const query = parse(basesQuery, request.query);
    return scrapedItemBasesResponseSchema.parse({
      correlationId: request.id,
      data: await service.listBases(query.gameDataVersion),
    });
  });

  api.put(
    `${scrapedItemsPath}/:id`,
    { bodyLimit: 32_768 },
    async (request, reply) => {
      const { id } = parse(idParams, request.params);
      return rejectable(request, reply, async () => {
        const body = parseBody(scrapedItemSaveInputSchema, request.body);
        return scrapedItemWriteResponseSchema.parse({
          correlationId: request.id,
          data: await service.save(id, body),
        });
      });
    },
  );

  api.post(
    `${scrapedItemsPath}/:id/recipes`,
    { bodyLimit: 2048 },
    async (request, reply) => {
      const { id } = parse(idParams, request.params);
      const body = parse(scrapedItemLinkInputSchema, request.body);
      return rejectable(request, reply, async () =>
        scrapedItemWriteResponseSchema.parse({
          correlationId: request.id,
          data: await service.link(id, body),
        }),
      );
    },
  );

  api.delete(
    `${scrapedItemsPath}/:id/recipes/:recipeId`,
    async (request, reply) => {
      const { id, recipeId } = parse(unlinkParams, request.params);
      const { expectedRevision } = parse(unlinkQuery, request.query);
      return rejectable(request, reply, async () =>
        scrapedItemWriteResponseSchema.parse({
          correlationId: request.id,
          data: await service.unlink(id, { expectedRevision, recipeId }),
        }),
      );
    },
  );

  api.post(
    `${scrapedItemsPath}/:id/tests`,
    { bodyLimit: 1024 },
    async (request, reply) => {
      const { id } = parse(idParams, request.params);
      const body = parse(scrapedItemRevisionInputSchema, request.body);
      return rejectable(request, reply, async () => {
        const test = await service.startTest(id, body);
        reply.code(202);
        return scrapedItemTestStartResponseSchema.parse({
          correlationId: request.id,
          data: test,
        });
      });
    },
  );

  api.get(`${scrapedItemsPath}/:id/tests/:requestId`, async (request) => {
    const { id, requestId } = parse(testParams, request.params);
    return scrapedItemTestResponseSchema.parse({
      correlationId: request.id,
      data: await service.readTest(id, requestId),
    });
  });

  api.get(`${scrapedItemsPath}/:id/capture`, async (request) => {
    const { id } = parse(idParams, request.params);
    return scrapedItemCaptureResponseSchema.parse({
      correlationId: request.id,
      data: await service.readLatestCapture(id),
    });
  });
}
