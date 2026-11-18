import { z } from 'zod';
import type { CraftProcedure } from './recipeSchema.js';

export const craftFamilySchema = z.enum([
  'alteration',
  'chaos',
  'essence',
  'fossil',
  'harvest',
  'bench',
  'other',
]);
export type CraftFamily = z.infer<typeof craftFamilySchema>;

export function recipeCraftFamilies(
  craft: Pick<CraftProcedure, 'method'>,
  stageFamilies: CraftFamily[] = [],
): CraftFamily[] {
  const method = craft.method;
  const primary: CraftFamily =
    method.kind === 'fossil'
      ? 'fossil'
      : method.kind === 'harvest-reforge'
        ? 'harvest'
        : method.currency === 'orb-of-alteration'
          ? 'alteration'
          : method.currency === 'chaos-orb'
            ? 'chaos'
            : /^(?:(?:whispering|muttering|weeping|wailing|screaming|shrieking|deafening)-)?essence-of-/.test(
                  method.currency,
                )
              ? 'essence'
              : 'other';
  return [...new Set([primary, ...stageFamilies])];
}
