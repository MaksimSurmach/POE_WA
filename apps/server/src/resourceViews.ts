import {
  type CatalogEntry,
  type CatalogResponse,
  type DomainErrorCode,
  domainErrorCodeSchema,
  type Price,
  type RecipeDetailView,
  type RecipeEvaluation as ApiRecipeEvaluation,
  type RecipeResponse,
  type RefreshStatus,
} from '@poe-worksmith/contracts';
import {
  DomainError,
  type Recipe as StoredRecipe,
  type RecipeEvaluation,
  type Repositories,
  validateRecipeV1,
} from '@poe-worksmith/domain';

export function createResourceReaders(repositories: Repositories) {
  return {
    async readCatalog(correlationId: string): Promise<CatalogResponse> {
      const [recipes, published, progress] = await Promise.all([
        repositories.recipes.listActive(),
        repositories.catalog.getPublished(),
        repositories.catalog.getProgress(),
      ]);
      const evaluations = new Map(
        published?.evaluations.map((evaluation) => [
          evaluation.recipeId,
          evaluation,
        ]),
      );
      const entries = recipes
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((recipe) => toCatalogEntry(recipe, evaluations.get(recipe.id)));

      return resourceResponse(
        correlationId,
        { entries },
        published?.cycle.publishedAt ?? null,
        refreshStatus(progress.active?.status ?? progress.published?.status),
      );
    },

    async readRecipe(
      correlationId: string,
      recipeId: string,
    ): Promise<RecipeResponse> {
      const [recipe, published, progress] = await Promise.all([
        repositories.recipes.findById(recipeId),
        repositories.catalog.getPublished(),
        repositories.catalog.getProgress(),
      ]);
      if (!recipe || !recipe.active) {
        throw new DomainError('PERSISTENCE_NOT_FOUND');
      }
      const evaluation = published?.evaluations.find(
        (candidate) => candidate.recipeId === recipe.id,
      );

      return resourceResponse(
        correlationId,
        toRecipeDetail(recipe, evaluation),
        published?.cycle.publishedAt ?? null,
        refreshStatus(progress.active?.status ?? progress.published?.status),
      );
    },
  };
}

function resourceResponse<T>(
  correlationId: string,
  data: T,
  publishedAt: Date | null,
  status: RefreshStatus,
) {
  if (!publishedAt) {
    return {
      correlationId,
      data,
      errorCode: null,
      isStale: false as const,
      lastSuccessfulAt: null,
      publishedAt: null,
      refreshStatus: status,
      state: 'loading' as const,
    };
  }
  return {
    correlationId,
    data,
    errorCode: null,
    isStale: false as const,
    lastSuccessfulAt: publishedAt.toISOString(),
    publishedAt: publishedAt.toISOString(),
    refreshStatus: status,
    state: 'success' as const,
  };
}

function toCatalogEntry(
  recipe: StoredRecipe,
  evaluation?: RecipeEvaluation,
): CatalogEntry {
  return {
    evaluation: toEvaluation(recipe.id, evaluation),
    recipe: toRecipeSummary(recipe, evaluation),
    snapshot: null,
  };
}

function toRecipeSummary(recipe: StoredRecipe, evaluation?: RecipeEvaluation) {
  const definition = validateRecipeV1(recipe.definition);
  return {
    category: recipe.category,
    craftMethod: recipe.craftMethod,
    id: recipe.id,
    minimumCapital: price(evaluation?.expectedCraftCost, evaluation?.currency),
    summary: definition.summary,
    tags: [...recipe.tags],
    title: recipe.title,
  };
}

function toEvaluation(
  recipeId: string,
  evaluation?: RecipeEvaluation,
): ApiRecipeEvaluation {
  if (!evaluation) {
    return {
      errorCode: null,
      estimatedSalePrice: null,
      evaluatedAt: null,
      expectedCraftCost: null,
      lastSuccessfulAt: null,
      marginPercent: null,
      profit: null,
      recipeId,
      snapshotId: null,
      status: 'loading',
    };
  }
  return {
    errorCode: errorCode(evaluation.errorCode),
    estimatedSalePrice: price(
      evaluation.estimatedSalePrice,
      evaluation.currency,
    ),
    evaluatedAt: evaluation.evaluatedAt.toISOString(),
    expectedCraftCost: price(evaluation.expectedCraftCost, evaluation.currency),
    lastSuccessfulAt: evaluation.lastSuccessfulAt?.toISOString() ?? null,
    marginPercent: finiteNumber(evaluation.marginPercent),
    profit: price(evaluation.profit, evaluation.currency),
    recipeId,
    snapshotId: null,
    status: evaluation.status,
  };
}

function toRecipeDetail(
  recipe: StoredRecipe,
  evaluation?: RecipeEvaluation,
): RecipeDetailView {
  const definition = validateRecipeV1(recipe.definition);
  const salePrice = price(evaluation?.estimatedSalePrice, evaluation?.currency);
  const estimatorId = estimatorLabel(definition.estimator);
  const requirements = [
    definition.baseRequirements.itemClass
      ? `Item class: ${definition.baseRequirements.itemClass}`
      : null,
    definition.baseRequirements.minItemLevel
      ? `Minimum item level: ${definition.baseRequirements.minItemLevel}`
      : null,
    ...(definition.baseRequirements.influences ?? []).map(
      (influence) => `Influence: ${influence}`,
    ),
  ].filter((value): value is string => value !== null);

  return {
    base: {
      name: definition.baseRequirements.baseType,
      requirements,
    },
    confidence: evaluation?.confidence ?? null,
    costBreakdown: null,
    craftSteps: definition.craftSteps.map((step) => step.title),
    estimators: salePrice
      ? [{ id: estimatorId, label: estimatorId, price: salePrice }]
      : [],
    evaluation: toEvaluation(recipe.id, evaluation),
    gameVersion: recipe.gameVersion,
    materials: definition.materials.map((material) => ({
      costPerAttempt: null,
      name: material.label,
      quantityPerAttempt: material.quantityPerAttempt,
      unitPrice: null,
    })),
    recipe: toRecipeSummary(recipe, evaluation),
    requiredMods: tradeStatIds(definition.output.tradeQuery.query),
    selectedEstimatorId: salePrice ? estimatorId : null,
    snapshot: null,
  };
}

function price(
  rawAmount: string | null | undefined,
  rawCurrency: string | null | undefined,
): Price | null {
  const amount = finiteNumber(rawAmount);
  if (amount === null || amount < 0) return null;
  if (rawCurrency !== 'chaos' && rawCurrency !== 'divine') return null;
  return { amount, currency: rawCurrency };
}

function finiteNumber(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function errorCode(value: string | null): DomainErrorCode | null {
  if (value === null) return null;
  const result = domainErrorCodeSchema.safeParse(value);
  return result.success ? result.data : 'INTERNAL_ERROR';
}

function refreshStatus(
  value:
    'queued' | 'running' | 'published' | 'failed' | 'superseded' | undefined,
): RefreshStatus {
  return value ?? 'idle';
}

function estimatorLabel(estimator: { strategy: string }) {
  return estimator.strategy.replaceAll('_', ' ');
}

function tradeStatIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(tradeStatIds);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const current =
    typeof record.id === 'string' && record.id.includes('.stat_')
      ? [record.id]
      : [];
  return [...current, ...Object.values(record).flatMap(tradeStatIds)];
}
