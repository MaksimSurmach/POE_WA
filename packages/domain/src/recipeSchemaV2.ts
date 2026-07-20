import { z } from 'zod';

import {
  canonicalCraftMethodSchema,
  canonicalStartingModSchema,
} from './canonical/craftMethod.js';
import { canonicalItemSpecSchema } from './canonical/item.js';
import type { CanonicalCraftSetup } from './canonical/setup.js';
import { canonicalTargetSpecSchema } from './canonical/target.js';
import { RecipeValidationError } from './recipeSchema.js';

const textSchema = z.string().trim().min(1);
const slugSchema = textSchema.regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  'Must be a lowercase kebab-case identifier',
);
const uniqueSlugs = z.array(slugSchema).superRefine((values, context) => {
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

const craftStepSchema = z.strictObject({
  id: slugSchema,
  title: textSchema,
});

const resourceConsumptionSchema = z.strictObject({
  materials: z
    .array(
      z.strictObject({
        itemId: textSchema,
        quantity: z.number().int().positive(),
      }),
    )
    .min(1)
    .superRefine((materials, context) => {
      const seen = new Set<string>();
      materials.forEach(({ itemId }, index) => {
        if (seen.has(itemId))
          context.addIssue({
            code: 'custom',
            message: `Duplicate resource "${itemId}"`,
            path: [index, 'itemId'],
          });
        seen.add(itemId);
      });
    }),
  source: z.enum([
    'authored-estimate',
    'automatic-probability',
    'manual-fixed-cost',
  ]),
});

export const recipeV2Schema = z.strictObject({
  base: canonicalItemSpecSchema,
  category: slugSchema,
  content: z.strictObject({
    craftSteps: z.array(craftStepSchema).default([]),
    notes: textSchema.optional(),
  }),
  craft: z.strictObject({
    method: canonicalCraftMethodSchema,
    resourceConsumption: resourceConsumptionSchema.optional(),
    startingMods: z.array(canonicalStartingModSchema).default([]),
  }),
  gameDataVersion: textSchema,
  id: slugSchema,
  schemaVersion: z.literal(2),
  summary: textSchema.optional(),
  tags: uniqueSlugs.default([]),
  target: canonicalTargetSpecSchema,
  title: textSchema,
});

export type CanonicalRecipeV2 = z.output<typeof recipeV2Schema>;
export type RecipeV2Input = z.input<typeof recipeV2Schema>;

export function validateRecipeV2(input: unknown): CanonicalRecipeV2 {
  const result = recipeV2Schema.safeParse(input);
  if (!result.success) throw new RecipeValidationError(result.error, 2);
  return result.data;
}

export function canonicalCraftSetupFromRecipe(
  recipe: CanonicalRecipeV2,
): CanonicalCraftSetup {
  return {
    base: recipe.base,
    gameDataVersion: recipe.gameDataVersion,
    method: recipe.craft.method,
    startingMods: recipe.craft.startingMods,
    target: recipe.target,
  };
}
