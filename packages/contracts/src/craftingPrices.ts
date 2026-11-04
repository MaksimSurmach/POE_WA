import { z } from 'zod';

export const craftingPricesResponseSchema = z.strictObject({
  correlationId: z.string(),
  data: z.strictObject({
    league: z.string().nullable(),
    checkedAt: z.iso.datetime(),
    quotes: z.array(
      z.strictObject({
        itemId: z.string().min(1),
        name: z.string().min(1),
        chaos: z.number().finite().positive(),
        capturedAt: z.iso.datetime(),
        verifiedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
      }),
    ),
  }),
});
export type CraftingPrices = z.infer<
  typeof craftingPricesResponseSchema
>['data'];
