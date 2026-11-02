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
  recipeVariantViewSchema,
} from '@poe-worksmith/contracts';
import {
  DomainError,
  type Recipe as StoredRecipe,
  type RecipeEvaluation,
  type Repositories,
  validateRecipeDocument,
} from '@poe-worksmith/domain';
import {
  createRecipeItemPresentation,
  type ItemPresentationCatalog,
} from './itemPresentation.js';

export function createResourceReaders(
  repositories: Repositories,
  presentationCatalog: ItemPresentationCatalog,
) {
  return {
    async readCatalog(correlationId: string): Promise<CatalogResponse> {
      const [recipes, currentPublished, progress, currentLeague] =
        await Promise.all([
          repositories.recipes.listActive(),
          repositories.catalog.getPublished(),
          repositories.catalog.getProgress(),
          repositories.leagues.findCurrent(),
        ]);
      const published =
        currentPublished?.cycle.leagueId === currentLeague?.id
          ? currentPublished
          : null;
      const evaluations = new Map(
        published?.evaluations.map((evaluation) => [
          evaluation.recipeId,
          evaluation,
        ]),
      );
      const entries = recipes
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((recipe) =>
          toCatalogEntry(
            recipe,
            evaluations.get(recipe.id),
            presentationCatalog,
          ),
        );

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
      const [recipe, currentPublished, progress, currentLeague] =
        await Promise.all([
          repositories.recipes.findById(recipeId),
          repositories.catalog.getPublished(),
          repositories.catalog.getProgress(),
          repositories.leagues.findCurrent(),
        ]);
      const published =
        currentPublished?.cycle.leagueId === currentLeague?.id
          ? currentPublished
          : null;
      if (!recipe || !recipe.active) {
        throw new DomainError('PERSISTENCE_NOT_FOUND');
      }
      const evaluation = published?.evaluations.find(
        (candidate) => candidate.recipeId === recipe.id,
      );

      return resourceResponse(
        correlationId,
        toRecipeDetail(recipe, evaluation, presentationCatalog),
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
  presentationCatalog?: ItemPresentationCatalog,
): CatalogEntry {
  const definition = validateRecipeDocument(recipe.definition);
  let itemPreview: CatalogEntry['itemPreview'];
  if (
    definition.schemaVersion === 2 &&
    presentationCatalog?.get(definition.base.baseId)
  ) {
    try {
      itemPreview = createRecipeItemPresentation({
        catalog: presentationCatalog,
        recipe: definition,
      }).target;
    } catch (cause) {
      if (!(cause instanceof DomainError) || cause.code !== 'RECIPE_INVALID')
        throw cause;
    }
  }
  return {
    evaluation: toEvaluation(recipe.id, evaluation),
    ...(itemPreview ? { itemPreview } : {}),
    recipe: toRecipeSummary(recipe, evaluation),
    snapshot: null,
  };
}

function toRecipeSummary(recipe: StoredRecipe, evaluation?: RecipeEvaluation) {
  const definition = validateRecipeDocument(recipe.definition);
  return {
    category: recipe.category,
    craftMethod: recipe.craftMethod,
    id: recipe.id,
    minimumCapital: price(evaluation?.expectedCraftCost, evaluation?.currency),
    summary: definition.summary ?? recipe.title,
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
      confidence: null,
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
    confidence: evaluation.confidence,
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
  presentationCatalog?: ItemPresentationCatalog,
): RecipeDetailView {
  const definition = validateRecipeDocument(recipe.definition);
  if (definition.schemaVersion === 2) {
    if (!presentationCatalog) throw new DomainError('RECIPE_INVALID');
    return toV2RecipeDetail(
      recipe,
      evaluation,
      definition,
      presentationCatalog,
    );
  }
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
    presentation: {
      base: {
        canonicalId: definition.baseRequirements.baseType,
        iconUrl: null,
        itemClass: definition.baseRequirements.itemClass ?? 'Unknown',
        itemLevel: definition.baseRequirements.minItemLevel ?? null,
        modifiers: [],
        name: definition.baseRequirements.baseType,
        properties: requirements.map((label) => ({
          id: label,
          label,
          value: null,
        })),
        rarity: null,
        role: 'base',
      },
      materials: definition.materials.map((material) => ({
        canonicalId: material.label,
        iconUrl: null,
        itemClass: 'Unknown',
        name: material.label,
        quantity: material.quantityPerAttempt,
        role: 'material',
        totalPrice: null,
        unitPrice: null,
      })),
      target: {
        canonicalId: definition.baseRequirements.baseType,
        iconUrl: null,
        itemClass: definition.baseRequirements.itemClass ?? 'Unknown',
        itemLevel: definition.baseRequirements.minItemLevel ?? null,
        modifiers: [],
        name: definition.baseRequirements.baseType,
        properties: [],
        rarity: null,
        role: 'target',
      },
      version: 1,
    },
    requiredMods: tradeStatIds(definition.output.tradeQuery.query),
    selectedEstimatorId: salePrice ? estimatorId : null,
    snapshot: null,
    variants: [],
  };
}

function toV2RecipeDetail(
  recipe: StoredRecipe,
  evaluation: RecipeEvaluation | undefined,
  definition: Extract<
    ReturnType<typeof validateRecipeDocument>,
    { schemaVersion: 2 }
  >,
  presentationCatalog: ItemPresentationCatalog,
): RecipeDetailView {
  const salePrice = price(evaluation?.estimatedSalePrice, evaluation?.currency);
  const presentation = createRecipeItemPresentation({
    catalog: presentationCatalog,
    recipe: definition,
  });
  const variants = (definition.craft.variants ?? []).map((variant) => {
    const saved = evaluation?.variantCosts?.[variant.id];
    const savedRecord =
      saved && typeof saved === 'object'
        ? (saved as Record<string, unknown>)
        : {};
    const savedSteps = Array.isArray(savedRecord.steps)
      ? savedRecord.steps.filter(
          (step): step is Record<string, unknown> =>
            Boolean(step) && typeof step === 'object',
        )
      : [];
    const cost = recipeVariantViewSchema.safeParse({
      expectedCost: persistedPrice(savedRecord.expectedCost),
      evidence: variant.evidence ?? null,
      expectedExecutions: variant.expectedExecutions ?? [],
      id: variant.id,
      materialsPerAttempt: persistedPrice(savedRecord.materialsPerAttempt),
      name: variant.name,
      steps: variant.steps.map((step) => ({
        action: step.action,
        continueWhen: step.continueWhen,
        failureAction: step.failureAction,
        id: step.id,
        materials: step.materials.map((material) => {
          const savedStep = savedSteps.find((value) => value.id === step.id);
          const savedMaterials = Array.isArray(savedStep?.materials)
            ? savedStep.materials.filter(
                (item): item is Record<string, unknown> =>
                  Boolean(item) && typeof item === 'object',
              )
            : [];
          const savedMaterial = savedMaterials.find(
            (value) => value.itemId === material.itemId,
          );
          return {
            costPerAttempt: persistedPrice(savedMaterial?.costPerAttempt),
            itemId: material.itemId,
            name:
              presentationCatalog.get(material.itemId)?.name ??
              material.itemId.replaceAll('-', ' '),
            quantityPerAttempt: material.quantity,
            unitPrice: persistedPrice(savedMaterial?.unitPrice),
          };
        }),
        success: step.success ?? null,
        title: step.title,
      })),
    });
    if (!cost.success) throw new DomainError('RECIPE_INVALID');
    return cost.data;
  });
  return {
    base: {
      name: presentation.base.name,
      requirements: presentation.base.properties.map(({ label, value }) =>
        value ? `${label}: ${value}` : label,
      ),
    },
    confidence: evaluation?.confidence ?? null,
    costBreakdown: null,
    craftSteps: definition.content.craftSteps.map(({ title }) => title),
    estimators: salePrice
      ? [{ id: 'cheapest', label: 'Cheapest ask', price: salePrice }]
      : [],
    evaluation: toEvaluation(recipe.id, evaluation),
    gameVersion: definition.gameDataVersion,
    materials: presentation.materials.map((material) => ({
      costPerAttempt: material.totalPrice,
      name: material.name,
      quantityPerAttempt: material.quantity,
      unitPrice: material.unitPrice,
    })),
    presentation,
    recipe: toRecipeSummary(recipe, evaluation),
    requiredMods:
      definition.target.minimumMatched === null
        ? []
        : [`At least ${definition.target.minimumMatched} target modifiers`],
    selectedEstimatorId: salePrice ? 'cheapest' : null,
    snapshot: null,
    variants,
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

function persistedPrice(value: unknown): Price | null {
  if (!value || typeof value !== 'object') return null;
  const { amount, currency } = value as Record<string, unknown>;
  return price(
    typeof amount === 'string' || typeof amount === 'number'
      ? String(amount)
      : null,
    typeof currency === 'string' ? currency : null,
  );
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
    | 'queued'
    | 'running'
    | 'completed'
    | 'published'
    | 'failed'
    | 'superseded'
    | undefined,
): RefreshStatus {
  return value === 'completed' ? 'idle' : (value ?? 'idle');
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
