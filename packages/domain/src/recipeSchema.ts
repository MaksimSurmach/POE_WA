import { z } from 'zod';

export const RECIPE_SCHEMA_VERSION = 1 as const;
export const RECIPE_UNKNOWN_FIELD_POLICY = 'reject' as const;

export type StructuredValue =
  | boolean
  | null
  | number
  | string
  | StructuredValue[]
  | { [key: string]: StructuredValue };

const structuredValueSchema: z.ZodType<StructuredValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number(),
    z.string(),
    z.array(structuredValueSchema),
    z.record(z.string(), structuredValueSchema),
  ]),
);

const structuredObjectSchema = z.record(z.string(), structuredValueSchema);
const nonEmptyStructuredObjectSchema = structuredObjectSchema.refine(
  (value) => Object.keys(value).length > 0,
  'Must contain at least one query field',
);
const textSchema = z.string().trim().min(1);
const slugSchema = textSchema.regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  'Must be a lowercase kebab-case identifier',
);

function uniqueSortedStrings(schema: z.ZodString) {
  return z
    .array(schema)
    .min(1)
    .superRefine((values, context) => {
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
    })
    .transform((values) => [...values].sort());
}

const tradeQuerySchema = z.strictObject({
  provider: z.literal('poe-trade'),
  query: nonEmptyStructuredObjectSchema,
  schemaVersion: z.literal(1),
});

const materialSchema = z.strictObject({
  id: slugSchema,
  label: textSchema,
  quantityPerAttempt: z.number().positive(),
  tradeQuery: tradeQuerySchema,
});

const finishingCostSchema = z.strictObject({
  id: slugSchema,
  label: textSchema,
  quantity: z.number().positive(),
  tradeQuery: tradeQuerySchema,
});

function uniqueIds(
  values: readonly { id: string }[],
  context: z.RefinementCtx,
) {
  const seen = new Set<string>();
  values.forEach(({ id }, index) => {
    if (seen.has(id)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate id "${id}"`,
        path: [index, 'id'],
      });
    }
    seen.add(id);
  });
}

const successSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('probability'),
    probability: z.number().gt(0).lte(1),
  }),
  z.strictObject({
    expectedAttempts: z.number().gte(1),
    mode: z.literal('expected_attempts'),
  }),
]);

const estimatorSchema = z.discriminatedUnion('strategy', [
  z.strictObject({ strategy: z.literal('cheapest') }),
  z.strictObject({
    n: z.number().int().min(1).max(10),
    strategy: z.literal('nth_cheapest'),
  }),
  z.strictObject({
    n: z.number().int().min(1).max(10),
    strategy: z.literal('median_top_n'),
  }),
  z.strictObject({
    n: z.number().int().min(1).max(10),
    strategy: z.literal('mean_top_n'),
  }),
  z.strictObject({
    percentile: z.number().gt(0).lte(100),
    strategy: z.literal('percentile'),
  }),
]);

const craftStepSchema = z.strictObject({
  id: slugSchema,
  metadata: structuredObjectSchema.optional(),
  title: textSchema,
});

export const recipeV1Schema = z.strictObject({
  baseRequirements: z.strictObject({
    baseType: textSchema,
    influences: uniqueSortedStrings(slugSchema).optional(),
    itemClass: textSchema.optional(),
    minItemLevel: z.number().int().min(1).max(100).optional(),
    tradeQuery: tradeQuerySchema,
  }),
  category: slugSchema,
  craftSteps: z.array(craftStepSchema).min(1).superRefine(uniqueIds),
  estimator: estimatorSchema,
  finishingCosts: z.array(finishingCostSchema).superRefine(uniqueIds),
  gameVersion: textSchema.regex(
    /^\d+\.\d+(?:\.\d+)?$/,
    'Must be a numeric game version such as 3.25',
  ),
  id: slugSchema,
  materials: z.array(materialSchema).min(1).superRefine(uniqueIds),
  output: z.strictObject({
    label: textSchema,
    tradeQuery: tradeQuerySchema,
  }),
  schemaVersion: z.literal(RECIPE_SCHEMA_VERSION),
  success: successSchema,
  summary: textSchema,
  tags: uniqueSortedStrings(slugSchema),
  title: textSchema,
});

export type CanonicalRecipeV1 = z.output<typeof recipeV1Schema>;
export type RecipeV1Input = z.input<typeof recipeV1Schema>;

export type RecipeValidationIssue = {
  code: string;
  message: string;
  path: string;
};

export class RecipeValidationError extends Error {
  readonly issues: readonly RecipeValidationIssue[];

  constructor(error: z.ZodError, schemaVersion = 1) {
    const issues = normalizeIssues(error.issues);
    super(
      `Invalid recipe v${schemaVersion}: ${issues
        .map(({ message, path }) => `${path}: ${message}`)
        .join('; ')}`,
      { cause: error },
    );
    this.name = 'RecipeValidationError';
    this.issues = issues;
  }
}

export function validateRecipeV1(input: unknown): CanonicalRecipeV1 {
  const result = recipeV1Schema.safeParse(input);
  if (!result.success) throw new RecipeValidationError(result.error);
  return result.data;
}

function normalizeIssues(
  issues: readonly z.core.$ZodIssue[],
): RecipeValidationIssue[] {
  const normalized: RecipeValidationIssue[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        normalized.push({
          code: issue.code,
          message: `Unknown field "${key}"`,
          path: formatPath([...issue.path, key]),
        });
      }
    } else {
      normalized.push({
        code: issue.code,
        message: issue.message,
        path: formatPath(issue.path),
      });
    }
  }
  return normalized;
}

function formatPath(path: readonly PropertyKey[]) {
  if (path.length === 0) return '$';
  return path.reduce<string>((result, segment) => {
    if (typeof segment === 'number') return `${result}[${segment}]`;
    return result ? `${result}.${String(segment)}` : String(segment);
  }, '');
}
