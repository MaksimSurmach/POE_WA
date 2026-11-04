import {
  generateRecipeMarketQuery,
  comparableRecipeListings,
  requiresCompleteOutputCoverage,
} from './recipeMarket.js';
import {
  type CatalogEntry,
  type CatalogResponse,
  type DomainErrorCode,
  domainErrorCodeSchema,
  type Price,
  type Profit,
  type RecipeDetailView,
  type RecipeEvaluation as ApiRecipeEvaluation,
  type RecipeResponse,
  type RefreshStatus,
  recipeMethodViewSchema,
  recipePriceSourceSchema,
  marketSnapshotSchema,
} from '@poe-worksmith/contracts';
import {
  DomainError,
  type CanonicalJsonObject,
  type Recipe as StoredRecipe,
  type RecipeEvaluation,
  type Repositories,
  validateRecipeDocument,
  hashMarketQuery,
  type TradeQueryGenerator,
} from '@poe-worksmith/domain';
import {
  createRecipeItemPresentation,
  createObservedItemPresentation,
  type ItemPresentationCatalog,
} from './itemPresentation.js';
import { marketTradeUrl } from './marketTradeQuery.js';

export function createResourceReaders(
  repositories: Repositories,
  presentationCatalog: ItemPresentationCatalog,
  trade?: TradeQueryGenerator,
  readMaximumQuoteAgeMs?: () => Promise<number>,
) {
  return {
    async readCatalog(correlationId: string): Promise<CatalogResponse> {
      const [
        recipes,
        currentPublished,
        progress,
        currentLeague,
        maximumQuoteAgeMs,
      ] = await Promise.all([
        repositories.recipes.listActive(),
        repositories.catalog.getPublished(),
        repositories.catalog.getProgress(),
        repositories.leagues.findCurrent(),
        readMaximumQuoteAgeMs?.(),
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
      const entries = await Promise.all(
        recipes
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(async (recipe) => {
            const evaluation = currentEvaluation(
              recipe,
              evaluations.get(recipe.id),
              maximumQuoteAgeMs,
            );
            const snapshot = await latestOutputSnapshot({
              currentLeague,
              evaluation,
              recipe,
              repositories,
              trade,
            });
            return toCatalogEntry(
              recipe,
              evaluation,
              presentationCatalog,
              snapshot,
            );
          }),
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
      const [
        recipe,
        currentPublished,
        progress,
        currentLeague,
        maximumQuoteAgeMs,
      ] = await Promise.all([
        repositories.recipes.findById(recipeId),
        repositories.catalog.getPublished(),
        repositories.catalog.getProgress(),
        repositories.leagues.findCurrent(),
        readMaximumQuoteAgeMs?.(),
      ]);
      const published =
        currentPublished?.cycle.leagueId === currentLeague?.id
          ? currentPublished
          : null;
      if (!recipe || !recipe.active) {
        throw new DomainError('PERSISTENCE_NOT_FOUND');
      }
      const definition = validateRecipeDocument(recipe.definition);
      const generatedBase =
        trade && currentLeague
          ? await generateRecipeMarketQuery(
              trade,
              definition,
              currentLeague.gggId,
              true,
            ).catch(() => null)
          : null;
      const baseTradeUrl =
        generatedBase && currentLeague
          ? marketTradeUrl(currentLeague.gggId, {
              query: generatedBase.query.query,
              sort: { price: 'asc' },
            })
          : null;
      const evaluation = currentEvaluation(
        recipe,
        published?.evaluations.find(
          (candidate) => candidate.recipeId === recipe.id,
        ),
        maximumQuoteAgeMs,
      );

      return resourceResponse(
        correlationId,
        {
          ...toRecipeDetail(recipe, evaluation, presentationCatalog),
          baseTradeUrl,
          snapshot: await latestOutputSnapshot({
            currentLeague,
            evaluation,
            recipe,
            repositories,
            trade,
          }),
        },
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
  snapshot?: CatalogEntry['snapshot'],
): CatalogEntry {
  const definition = validateRecipeDocument(recipe.definition);
  let itemPreview: CatalogEntry['itemPreview'];
  if (presentationCatalog?.get(definition.base.baseId)) {
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
    snapshot: snapshot ?? null,
  };
}

async function latestOutputSnapshot(input: {
  currentLeague: Awaited<ReturnType<Repositories['leagues']['findCurrent']>>;
  evaluation: RecipeEvaluation | undefined;
  recipe: StoredRecipe;
  repositories: Repositories;
  trade: TradeQueryGenerator | undefined;
}): Promise<CatalogEntry['snapshot']> {
  if (!input.currentLeague) return null;
  const definition = validateRecipeDocument(input.recipe.definition);
  if (!input.trade) return null;
  const result = await generateRecipeMarketQuery(
    input.trade,
    definition,
    input.currentLeague.gggId,
  ).catch(() => null);
  if (!result) return null;
  const queryHash = await hashMarketQuery({
    league: input.currentLeague.gggId,
    provider: 'poe-trade',
    query: result.query,
    schemaVersion: 1,
  });
  const marketQuery =
    await input.repositories.marketQueries.findByCanonicalHash(queryHash);
  if (!marketQuery) return null;
  const snapshot = await input.repositories.snapshots.findLatest(
    marketQuery.id,
    input.currentLeague.id,
  );
  if (
    !snapshot ||
    snapshot.expiresAt.getTime() <= Date.now() ||
    (input.evaluation?.sourceSnapshotDedupeKey &&
      snapshot.dedupeKey !== input.evaluation.sourceSnapshotDedupeKey)
  )
    return null;
  const listings = Array.isArray(snapshot.payload.listings)
    ? snapshot.payload.listings
    : [];
  const parsed = marketSnapshotSchema.safeParse({
    id: String(snapshot.id),
    queryHash,
    capturedAt: snapshot.capturedAt.toISOString(),
    expiresAt: snapshot.expiresAt.toISOString(),
    coverage: snapshot.payload.coverage ?? 'unknown',
    sortedPageComplete:
      !requiresCompleteOutputCoverage(result.query) &&
      snapshot.payload.sortedPageComplete === true,
    sortedSampleComplete:
      !requiresCompleteOutputCoverage(result.query) &&
      snapshot.payload.sortedSampleComplete === true,
    totalResults: snapshot.payload.totalResults,
    listings: comparableRecipeListings(
      result.query,
      listings.flatMap((value) => {
        if (!value || typeof value !== 'object') return [];
        const row = value as Record<string, unknown>;
        const price = row.price as Record<string, unknown> | undefined;
        const amount =
          typeof price?.amount === 'string'
            ? Number(price.amount)
            : price?.amount;
        if (
          typeof row.id !== 'string' ||
          typeof row.account !== 'string' ||
          typeof row.indexedAt !== 'string' ||
          typeof row.ageSeconds !== 'number' ||
          typeof amount !== 'number' ||
          (price?.currency !== 'chaos' && price?.currency !== 'divine')
        )
          return [];
        return [
          {
            id: row.id,
            account: row.account,
            fee: null,
            item: (row.item as CanonicalJsonObject) ?? {},
            indexedAt: new Date(row.indexedAt),
            ageSeconds: row.ageSeconds,
            price: { amount: String(amount), currency: price.currency },
          },
        ];
      }),
      snapshot.capturedAt,
      new Date(),
    ).map((row) => ({
      id: row.id,
      seller: row.account,
      indexedAt: row.indexedAt.toISOString(),
      ageSeconds: row.ageSeconds,
      price: { amount: Number(row.price.amount), currency: row.price.currency },
      ...(createObservedItemPresentation(row.item)
        ? { itemPreview: createObservedItemPresentation(row.item)! }
        : {}),
    })),
  });
  return parsed.success ? parsed.data : null;
}

function toRecipeSummary(recipe: StoredRecipe, evaluation?: RecipeEvaluation) {
  const definition = validateRecipeDocument(recipe.definition);
  return {
    category: recipe.category,
    craftMethod: recipe.craftMethod,
    patch: definition.patch,
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
  const source = record(evaluation.methodCost?.source);
  const saleEvidence = record(evaluation.methodCost?.saleEvidence);
  const priceSource = recipePriceSourceSchema.safeParse({
    capturedAt: source?.capturedAt,
    comparableSellers: source?.sampleSize,
    coverage: source?.coverage ?? 'unknown',
  });
  return {
    ...(priceSource.success ? { source: priceSource.data } : {}),
    ...(typeof saleEvidence?.reason === 'string'
      ? { profitBlockedReason: saleEvidence.reason }
      : {}),
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
    profit: profit(evaluation.profit, evaluation.currency),
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
  if (!presentationCatalog) throw new DomainError('RECIPE_INVALID');
  const salePrice = price(evaluation?.estimatedSalePrice, evaluation?.currency);
  const presentation = createRecipeItemPresentation({
    catalog: presentationCatalog,
    recipe: definition,
  });
  const procedure = definition.craft;
  const method = (() => {
    const saved = evaluation?.methodCost;
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
    const cost = recipeMethodViewSchema.safeParse({
      baseCost: persistedPrice(savedRecord.baseCost),
      expectedBases:
        typeof savedRecord.expectedBases === 'number'
          ? savedRecord.expectedBases
          : (procedure.baseConsumption?.expectedBases ?? null),
      marketStatus: ['priced', 'empty', 'partial'].includes(
        String(savedRecord.marketStatus),
      )
        ? savedRecord.marketStatus
        : 'unavailable',
      priceSources:
        savedRecord.materialEvidence &&
        typeof savedRecord.materialEvidence === 'object'
          ? Object.values(savedRecord.materialEvidence)
          : [],
      expectedCost: persistedPrice(savedRecord.expectedCost),
      evidence: procedure.evidence ?? null,
      expectedExecutions: procedure.expectedExecutions ?? [],
      id: procedure.id,
      materialsPerAttempt: persistedPrice(savedRecord.materialsPerAttempt),
      name: procedure.name,
      steps: procedure.steps.map((step) => ({
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
  })();
  return {
    baseTradeUrl: null,
    base: {
      name: presentation.base.name,
      requirements: presentation.base.properties.map(({ label, value }) =>
        value ? `${label}: ${value}` : label,
      ),
    },
    confidence: evaluation?.confidence ?? null,
    costBreakdown: null,
    craftSteps: definition.craft.steps.map(({ title }) => title),
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
    requiredMods: presentation.target.modifiers.map(({ label }) => label),
    selectedEstimatorId: salePrice ? 'cheapest' : null,
    snapshot: null,
    method,
    targetSignature: definition.targetSignature,
    verification: definition.verification.status,
    uncertainties: definition.craft.uncertainties,
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

function profit(
  rawAmount: string | null | undefined,
  rawCurrency: string | null | undefined,
): Profit | null {
  const amount = finiteNumber(rawAmount);
  if (amount === null) return null;
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

function currentEvaluation(
  recipe: StoredRecipe,
  evaluation: RecipeEvaluation | undefined,
  maximumQuoteAgeMs?: number,
) {
  if (evaluation?.methodCost?.recipeContentHash !== recipe.contentHash)
    return undefined;
  const expiresAt = evaluation.methodCost.expiresAt;
  const oldestInputAt = evaluation.methodCost.oldestInputAt;
  const policyExpired =
    maximumQuoteAgeMs !== undefined &&
    (typeof oldestInputAt === 'string'
      ? !Number.isFinite(Date.parse(oldestInputAt)) ||
        Date.parse(oldestInputAt) + maximumQuoteAgeMs <= Date.now()
      : maximumQuoteAgeMs < 30 * 60_000 ||
        evaluation.evaluatedAt.getTime() + maximumQuoteAgeMs <= Date.now());
  if (
    (typeof expiresAt === 'string' && Date.parse(expiresAt) <= Date.now()) ||
    policyExpired
  ) {
    return {
      ...evaluation,
      status: 'stale' as const,
      estimatedSalePrice: null,
      expectedCraftCost: null,
      profit: null,
      marginPercent: null,
      methodCost: {
        ...evaluation.methodCost,
        expectedCost: null,
        marketStatus: 'unavailable',
      },
    };
  }
  return withoutUnsupportedProfit(evaluation);
}

/** Matches the publisher's minimum before a cheapest ask may yield profit or ROI. */
const minimumComparableSellers = 2;

/**
 * Old evaluations may rely on one seller or a mixed-currency result prefix.
 * All generated output queries include mixed currencies: only complete coverage
 * supports the cheapest ask. Keep costs, but withhold unsupported resale/ROI.
 */
function withoutUnsupportedProfit(evaluation: RecipeEvaluation) {
  const methodCost = evaluation.methodCost ?? {};
  const saleEvidence = record(methodCost.saleEvidence);
  const source = record(methodCost.source);
  const sellers =
    typeof saleEvidence?.comparableSellers === 'number'
      ? saleEvidence.comparableSellers
      : typeof source?.sampleSize === 'number'
        ? source.sampleSize
        : null;
  const incompleteCoverage = source?.coverage !== 'complete';
  const insufficient =
    incompleteCoverage ||
    (saleEvidence !== null && saleEvidence.status !== 'accepted') ||
    sellers === null ||
    !Number.isSafeInteger(sellers) ||
    sellers < minimumComparableSellers ||
    source?.currencyAvailable === false;
  if (
    !insufficient ||
    (evaluation.profit === null &&
      evaluation.marginPercent === null &&
      (!incompleteCoverage || evaluation.estimatedSalePrice === null))
  )
    return evaluation;
  return {
    ...evaluation,
    status:
      evaluation.status === 'success'
        ? ('partial' as const)
        : evaluation.status,
    lastSuccessfulAt: null,
    estimatedSalePrice: incompleteCoverage
      ? null
      : evaluation.estimatedSalePrice,
    profit: null,
    marginPercent: null,
    methodCost: {
      ...methodCost,
      saleEvidence: {
        ...saleEvidence,
        comparableSellers: sellers,
        minimumComparableSellers,
        ...(incompleteCoverage && typeof saleEvidence?.reason !== 'string'
          ? {
              reason:
                'Incomplete output coverage: Trade order may differ from converted prices. Refresh a narrower target before deriving ROI.',
            }
          : {}),
        status:
          saleEvidence?.status && saleEvidence.status !== 'accepted'
            ? saleEvidence.status
            : incompleteCoverage
              ? 'insufficient_coverage'
              : sellers === null
                ? 'unavailable'
                : 'insufficient_sellers',
      },
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
