import { z } from 'zod';

const entityIdSchema = z.string().trim().min(1);
const uniqueStrings = z.array(entityIdSchema).superRefine((values, context) => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate value "${value}"`,
        path: [index],
      });
    }
    seen.add(value);
  });
});

export const itemVariantSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('cluster-jewel'),
    passiveCount: z.number().int().min(1).max(12),
    smallPassiveStatId: entityIdSchema,
  }),
]);

export const canonicalItemSpecSchema = z.strictObject({
  baseId: entityIdSchema,
  enchantments: uniqueStrings.optional(),
  implicits: uniqueStrings.optional(),
  influences: uniqueStrings.default([]),
  itemLevel: z.number().int().min(1).max(100),
  rarity: z.enum(['normal', 'magic', 'rare', 'unique']),
  state: z.strictObject({
    corrupted: z.boolean().default(false),
    fractured: z.boolean().default(false),
    synthesised: z.boolean().default(false),
  }),
  variant: itemVariantSchema,
});

export type CanonicalItemSpec = z.output<typeof canonicalItemSpecSchema>;
export type ItemVariant = z.output<typeof itemVariantSchema>;
