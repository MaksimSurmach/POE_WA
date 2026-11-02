import { z } from 'zod';

import {
  canonicalCraftMethodSchema,
  canonicalStartingModSchema,
} from './canonical/craftMethod.js';
import { canonicalItemSpecSchema } from './canonical/item.js';
import type { CanonicalCraftSetup } from './canonical/setup.js';
import {
  canonicalTargetConditionSchema,
  canonicalTargetSpecSchema,
} from './canonical/target.js';
import { hashCanonicalCraftSetup } from './canonical/normalization.js';

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

const evidenceSchema = z.strictObject({
  method: textSchema,
  patch: textSchema,
  url: z.string().url(),
  verifiedAt: z.iso.date(),
  settings: textSchema,
  artifact: textSchema,
  assumptions: textSchema,
});

const methodMaterialSchema = z.strictObject({
  itemId: textSchema,
  quantity: z.number().positive().nullable(),
});

const methodStepSchema = z.strictObject({
  action: textSchema,
  continueWhen: textSchema,
  failureAction: textSchema,
  id: slugSchema,
  materials: z.array(methodMaterialSchema).default([]),
  success: z
    .strictObject({
      evidence: evidenceSchema,
      probability: z.number().gt(0).lte(1),
    })
    .optional(),
  title: textSchema,
});

const craftProcedureSchema = z
  .strictObject({
    evidence: evidenceSchema.optional(),
    method: canonicalCraftMethodSchema,
    startingMods: z.array(canonicalStartingModSchema).default([]),
    baseConsumption: z
      .strictObject({
        expectedBases: z.number().gte(1),
        evidence: evidenceSchema,
      })
      .optional(),
    uncertainties: z.array(textSchema).default([]),
    id: slugSchema,
    name: textSchema,
    steps: z.array(methodStepSchema).min(1),
    // Expected material usage is entered per completed item so conditional stages
    // are never priced by multiplying all step costs by 1 / probability.
    expectedExecutions: z
      .array(
        z.strictObject({
          count: z.number().positive(),
          evidence: evidenceSchema,
          stepId: slugSchema,
        }),
      )
      .optional(),
  })
  .superRefine((procedure, context) => {
    const stepIds = new Set<string>();
    procedure.steps.forEach((step, index) => {
      if (stepIds.has(step.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate step id "${step.id}"`,
          path: ['steps', index, 'id'],
        });
      }
      stepIds.add(step.id);
    });
    const executionIds = new Set<string>();
    procedure.expectedExecutions?.forEach((execution, index) => {
      if (!stepIds.has(execution.stepId)) {
        context.addIssue({
          code: 'custom',
          message: `Unknown step id "${execution.stepId}"`,
          path: ['expectedExecutions', index, 'stepId'],
        });
      }
      if (executionIds.has(execution.stepId)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate execution count for "${execution.stepId}"`,
          path: ['expectedExecutions', index, 'stepId'],
        });
      }
      executionIds.add(execution.stepId);
    });
  });

export const recipeSchema = z.strictObject({
  base: canonicalItemSpecSchema.omit({ implicits: true, enchantments: true }),
  category: slugSchema,
  notes: textSchema.optional(),
  craft: craftProcedureSchema,
  startingBase: canonicalItemSpecSchema.omit({
    implicits: true,
    enchantments: true,
  }),
  patch: textSchema,
  verification: z.strictObject({
    status: z.enum(['verified', 'unverified']),
    leagues: z.array(textSchema).default([]),
    checkedAt: z.iso.date(),
    sources: z.array(z.url()).min(1),
    notes: textSchema,
  }),
  gameDataVersion: textSchema,
  imageUrl: z.string().url().optional(),
  id: slugSchema,
  schemaVersion: z.literal(3),
  summary: textSchema.optional(),
  tags: uniqueSlugs.default([]),
  targetSignature: textSchema,
  target: z.strictObject({
    prefixes: z.array(canonicalTargetConditionSchema),
    suffixes: z.array(canonicalTargetConditionSchema),
    implicits: z.array(canonicalTargetConditionSchema),
    other: z.array(canonicalTargetConditionSchema),
  }),
  title: textSchema,
});

export type CanonicalRecipe = z.output<typeof recipeSchema>;
export type RecipeInput = z.input<typeof recipeSchema>;
export type CraftProcedure = CanonicalRecipe['craft'];
export type LoadedRecipeDefinition = CanonicalRecipe;

export function validateRecipeDocument(input: unknown): CanonicalRecipe {
  const result = recipeSchema.safeParse(input);
  if (!result.success) throw new RecipeValidationError(result.error);
  const recipe = result.data;
  const target = canonicalTargetSpecSchema.safeParse({
    allOf: Object.values(recipe.target).flat(),
    anyOf: [],
    minimumMatched: null,
  });
  if (!target.success) throw new RecipeValidationError(target.error);
  if (
    Object.values(recipe.target)
      .flat()
      .some((c) => c.excluded)
  )
    throw new RecipeValidationError(
      new z.ZodError([
        {
          code: 'custom',
          path: ['target'],
          message:
            'Excluded modifier requirements are not supported by recipe queries',
        },
      ]),
    );
  for (const [group, conditions] of Object.entries(recipe.target)) {
    for (const condition of conditions) {
      const valid =
        group === 'prefixes' || group === 'suffixes'
          ? ['explicit', 'fractured'].includes(condition.kind)
          : group === 'implicits'
            ? condition.kind === 'implicit'
            : ['enchant', 'pseudo'].includes(condition.kind);
      if (!valid)
        throw new RecipeValidationError(
          new z.ZodError([
            {
              code: 'custom',
              path: ['target', group],
              message: 'Modifier kind does not belong to its affix group',
            },
          ]),
        );
    }
  }
  const evidence = [
    ...(recipe.craft.expectedExecutions?.map((e) => e.evidence) ?? []),
    ...recipe.craft.steps.flatMap((s) =>
      s.success ? [s.success.evidence] : [],
    ),
    ...(recipe.craft.baseConsumption
      ? [recipe.craft.baseConsumption.evidence]
      : []),
  ];
  if (evidence.some((e) => e.patch !== recipe.patch))
    throw new RecipeValidationError(
      new z.ZodError([
        {
          code: 'custom',
          path: ['craft'],
          message: 'Calculation evidence patch does not match the recipe',
        },
      ]),
    );
  if (result.data.targetSignature !== recipeTargetSignature(result.data))
    throw new RecipeValidationError(
      new z.ZodError([
        {
          code: 'custom',
          path: ['targetSignature'],
          message: `Target signature does not match the output specification; expected ${recipeTargetSignature(result.data)}`,
        },
      ]),
    );
  return result.data;
}

export function canonicalCraftSetupFromRecipe(
  recipe: CanonicalRecipe,
): CanonicalCraftSetup {
  return {
    base: recipe.base,
    gameDataVersion: recipe.gameDataVersion,
    method: recipe.craft.method,
    startingMods: recipe.craft.startingMods,
    target: {
      allOf: Object.values(recipe.target).flat(),
      anyOf: [],
      minimumMatched: null,
    },
  };
}

// Method and starting conditions cannot partition offers for the same finished output.
export function recipeTargetSignature(recipe: CanonicalRecipe) {
  return `${recipe.patch}:${hashCanonicalCraftSetup({
    ...canonicalCraftSetupFromRecipe(recipe),
    method: { kind: 'currency', currency: 'signature' },
    startingMods: [],
  })}`;
}

export function recipeDocumentMetadata(recipe: CanonicalRecipe) {
  return {
    category: recipe.category,
    craftMethod: recipe.craft.name,
    gameVersion: recipe.patch,
    id: recipe.id,
    tags: recipe.tags,
    title: recipe.title,
  };
}

export class RecipeValidationError extends Error {
  readonly issues: readonly { code: string; message: string; path: string }[];
  constructor(error: z.ZodError) {
    const issues = error.issues.flatMap<{
      code: string;
      message: string;
      path: string;
    }>((issue) =>
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => ({
            code: issue.code,
            message: `Unknown field "${key}"`,
            path: [...issue.path, key].join('.'),
          }))
        : [
            {
              code: issue.code,
              message: issue.message,
              path: issue.path.join('.') || '$',
            },
          ],
    );
    super(
      `Invalid recipe: ${issues.map(({ path, message }) => `${path}: ${message}`).join('; ')}`,
      { cause: error },
    );
    this.name = 'RecipeValidationError';
    this.issues = issues;
  }
}
