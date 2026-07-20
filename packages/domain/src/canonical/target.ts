import { z } from 'zod';

const entityIdSchema = z.string().trim().min(1);
const tierSchema = z.number().int().min(1).max(20);

export const canonicalTargetConditionSchema = z
  .strictObject({
    exactTier: tierSchema.optional(),
    excluded: z.boolean().default(false),
    kind: z.enum(['explicit', 'implicit', 'enchant', 'fractured', 'pseudo']),
    maximumTier: tierSchema.optional(),
    maximumValue: z.number().finite().optional(),
    minimumTier: tierSchema.optional(),
    minimumValue: z.number().finite().optional(),
    modFamilyId: entityIdSchema.optional(),
    modId: entityIdSchema.optional(),
  })
  .superRefine((condition, context) => {
    const identities =
      Number(condition.modId !== undefined) +
      Number(condition.modFamilyId !== undefined);
    if (identities !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Specify exactly one of modId or modFamilyId',
        path: ['modId'],
      });
    }
    if (
      condition.exactTier !== undefined &&
      (condition.minimumTier !== undefined ||
        condition.maximumTier !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'exactTier cannot be combined with minimumTier or maximumTier',
        path: ['exactTier'],
      });
    }
    if (
      condition.minimumTier !== undefined &&
      condition.maximumTier !== undefined &&
      condition.minimumTier > condition.maximumTier
    ) {
      context.addIssue({
        code: 'custom',
        message: 'minimumTier cannot exceed maximumTier',
        path: ['minimumTier'],
      });
    }
    if (
      condition.minimumValue !== undefined &&
      condition.maximumValue !== undefined &&
      condition.minimumValue > condition.maximumValue
    ) {
      context.addIssue({
        code: 'custom',
        message: 'minimumValue cannot exceed maximumValue',
        path: ['minimumValue'],
      });
    }
  });

export type CanonicalTargetCondition = z.output<
  typeof canonicalTargetConditionSchema
>;

export const canonicalTargetSpecSchema = z
  .strictObject({
    allOf: z.array(canonicalTargetConditionSchema).default([]),
    anyOf: z.array(canonicalTargetConditionSchema).default([]),
    minimumMatched: z.number().int().positive().nullable().default(null),
  })
  .superRefine((target, context) => {
    if (
      target.minimumMatched !== null &&
      target.minimumMatched > target.anyOf.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'minimumMatched cannot exceed the number of anyOf conditions',
        path: ['minimumMatched'],
      });
    }
    const seen = new Map<
      string,
      { excluded: boolean; index: number; group: 'allOf' | 'anyOf' }
    >();
    for (const group of ['allOf', 'anyOf'] as const) {
      target[group].forEach((condition, index) => {
        const identity = `${condition.kind}:${condition.modId ?? condition.modFamilyId}`;
        const previous = seen.get(identity);
        if (previous && previous.excluded !== condition.excluded) {
          context.addIssue({
            code: 'custom',
            message: `Contradictory excluded condition also appears at ${previous.group}[${previous.index}]`,
            path: [group, index],
          });
        } else if (previous && group === previous.group) {
          context.addIssue({
            code: 'custom',
            message: `Duplicate condition also appears at ${previous.group}[${previous.index}]`,
            path: [group, index],
          });
        } else {
          seen.set(identity, { excluded: condition.excluded, index, group });
        }
      });
    }
  });

export type CanonicalTargetSpec = z.output<typeof canonicalTargetSpecSchema>;
