import { z } from 'zod';

const entityIdSchema = z.string().trim().min(1);
const uniqueEntityIds = z
  .array(entityIdSchema)
  .min(1)
  .superRefine((values, context) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value))
        context.addIssue({
          code: 'custom',
          message: `Duplicate value "${value}"`,
          path: [index],
        });
      seen.add(value);
    });
  });

export const canonicalCraftMethodSchema = z.discriminatedUnion('kind', [
  z.strictObject({ currency: entityIdSchema, kind: z.literal('currency') }),
  z.strictObject({ kind: z.literal('harvest-reforge'), tag: entityIdSchema }),
  z.strictObject({
    fossils: uniqueEntityIds,
    kind: z.literal('fossil'),
    resonatorSockets: z.number().int().min(1).max(4),
  }),
]);

export const canonicalStartingModSchema = z
  .strictObject({
    modId: entityIdSchema,
    tier: z.number().int().min(1).max(20).optional(),
    kind: z.enum(['explicit', 'fractured', 'implicit']).optional(),
    minimumValue: z.number().finite().optional(),
    maximumValue: z.number().finite().optional(),
  })
  .refine(
    (mod) =>
      mod.minimumValue === undefined ||
      mod.maximumValue === undefined ||
      mod.minimumValue <= mod.maximumValue,
    'minimumValue cannot exceed maximumValue',
  );

export type CanonicalCraftMethod = z.output<typeof canonicalCraftMethodSchema>;
export type CanonicalStartingMod = z.output<typeof canonicalStartingModSchema>;
