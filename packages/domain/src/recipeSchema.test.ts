import { describe, expect, it } from 'vitest';

import {
  invalidRecipeV1Fixture,
  validRecipeV1Fixture,
} from './fixtures/recipes.js';
import {
  RecipeValidationError,
  recipeV1Schema,
  RECIPE_UNKNOWN_FIELD_POLICY,
  validateRecipeV1,
} from './recipeSchema.js';

function validationError(input: unknown) {
  try {
    validateRecipeV1(input);
    throw new Error('Expected recipe validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(RecipeValidationError);
    return error as RecipeValidationError;
  }
}

describe('recipe schema v1', () => {
  it('creates a parser-independent canonical recipe from a valid fixture', () => {
    const recipe = validateRecipeV1(validRecipeV1Fixture);

    expect(recipe).toMatchObject({
      estimator: { n: 10, strategy: 'median_top_n' },
      id: 'physical-large-cluster',
      schemaVersion: 1,
      success: { expectedAttempts: 6, mode: 'expected_attempts' },
    });
    expect(recipe.tags).toEqual(['cluster-jewel', 'profit']);
  });

  it('reports a concrete path for a missing required field', () => {
    const missingSummary: Record<string, unknown> = {
      ...validRecipeV1Fixture,
    };
    delete missingSummary.summary;

    expect(validationError(missingSummary).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_type', path: 'summary' }),
      ]),
    );
  });

  it('reports a concrete nested path for an invalid fixture', () => {
    expect(validationError(invalidRecipeV1Fixture).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'too_small',
          path: 'materials[0].quantityPerAttempt',
        }),
      ]),
    );
  });

  it('rejects unknown fields at top-level and nested schema boundaries', () => {
    expect(RECIPE_UNKNOWN_FIELD_POLICY).toBe('reject');
    const topLevel = validationError({
      ...validRecipeV1Fixture,
      wikiUrl: 'https://example.invalid',
    });
    const nested = validationError({
      ...validRecipeV1Fixture,
      materials: [{ ...validRecipeV1Fixture.materials[0], unit: 'lifeforce' }],
    });

    expect(topLevel.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unrecognized_keys',
          path: 'wikiUrl',
        }),
      ]),
    );
    expect(nested.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unrecognized_keys',
          path: 'materials[0].unit',
        }),
      ]),
    );
  });

  it('allows open JSON only inside explicit query and metadata payloads', () => {
    const parsed = recipeV1Schema.parse({
      ...validRecipeV1Fixture,
      craftSteps: [
        {
          ...validRecipeV1Fixture.craftSteps[0],
          metadata: { arbitraryProviderMetadata: { supported: true } },
        },
      ],
    });

    expect(parsed.craftSteps[0]?.metadata).toEqual({
      arbitraryProviderMetadata: { supported: true },
    });
  });

  it('enforces one manual success model and strategy-specific estimator bounds', () => {
    const mixedSuccess = validationError({
      ...validRecipeV1Fixture,
      success: {
        expectedAttempts: 4,
        mode: 'probability',
        probability: 0.25,
      },
    });
    const invalidEstimator = validationError({
      ...validRecipeV1Fixture,
      estimator: { n: 12, strategy: 'nth_cheapest' },
    });

    expect(mixedSuccess.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'success.expectedAttempts' }),
      ]),
    );
    expect(invalidEstimator.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'estimator.n' }),
      ]),
    );
  });

  it('supports both manual success models and every estimator strategy', () => {
    expect(
      recipeV1Schema.parse({
        ...validRecipeV1Fixture,
        success: { mode: 'probability', probability: 0.25 },
      }).success,
    ).toEqual({ mode: 'probability', probability: 0.25 });

    const estimators = [
      { strategy: 'cheapest' },
      { n: 3, strategy: 'nth_cheapest' },
      { n: 5, strategy: 'median_top_n' },
      { n: 5, strategy: 'mean_top_n' },
      { percentile: 25, strategy: 'percentile' },
    ];
    for (const estimator of estimators) {
      expect(
        recipeV1Schema.safeParse({
          ...validRecipeV1Fixture,
          estimator,
        }).success,
      ).toBe(true);
    }
  });
});
