import {
  generateRecipeMarketQuery,
  comparableRecipeListings,
  requiresCompleteOutputCoverage,
} from './recipeMarket.js';
import {
  type CatalogEntry,
  type CatalogResponse,
  type CollectorReadinessResponse,
  type DomainErrorCode,
  domainErrorCodeSchema,
  type Price,
  type Profit,
  type RecipeDetailView,
  type RecipeEvaluation as ApiRecipeEvaluation,
  type RecipeResponse,
  type RefreshStatus,
  recipeEvaluationSchema,
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
import {
  targetReadiness,
  type CollectorReadinessReader,
} from './collectorReadiness.js';
import type { MarketActivityReader } from './marketActivity.js';
import { marketTradeUrl } from './marketTradeQuery.js';
import { recipeResultSchema } from './recipeResult.js';
import type { recipeResults } from './schema.js';
import {
  revalueSavedTradeListings,
  savedTradeExchangeSchema,
} from './marketCurrency.js';

type ResourceEvaluation = Pick<
  RecipeEvaluation,
  | 'confidence'
  | 'currency'
  | 'errorCode'
  | 'estimatedSalePrice'
  | 'evaluatedAt'
  | 'expectedCraftCost'
  | 'lastSuccessfulAt'
  | 'marginPercent'
  | 'methodCost'
  | 'profit'
  | 'status'
>;

type CollectorResultRow = typeof recipeResults.$inferSelect;
type CollectorResultsReader = (
  leagueId?: string,
  recipeId?: string,
) => Promise<CollectorResultRow[]>;

export function createResourceReaders(
  repositories: Repositories,
  presentationCatalog: ItemPresentationCatalog,
  trade?: TradeQueryGenerator,
  readMaximumQuoteAgeMs?: () => Promise<number>,
  readCollectorResults?: CollectorResultsReader,
  readMarketActivity?: MarketActivityReader,
  readReadiness?: CollectorReadinessReader,
) {
  const recipeDocuments = new Map<
    string,
    ReturnType<typeof validateRecipeDocument>
  >();
  function readRecipeDocument(recipe: StoredRecipe) {
    const cached = recipeDocuments.get(recipe.contentHash);
    if (cached) return cached;
    const definition = validateRecipeDocument(recipe.definition);
    if (recipeDocuments.size >= 256)
      recipeDocuments.delete(recipeDocuments.keys().next().value!);
    recipeDocuments.set(recipe.contentHash, definition);
    return definition;
  }

  async function readMarket(recipeId?: string) {
    const catalogUsesCollector = readCollectorResults && recipeId === undefined;
    const [currentLeague, maximumQuoteAgeMs, published, progress] =
      await Promise.all([
        catalogUsesCollector ? null : repositories.leagues.findCurrent(),
        readMaximumQuoteAgeMs?.(),
        readCollectorResults ? null : repositories.catalog.getPublished(),
        readCollectorResults ? null : repositories.catalog.getProgress(),
      ]);
    const legacy =
      published?.cycle.leagueId === currentLeague?.id ? published : null;
    const legacyEvaluations = new Map(
      legacy?.evaluations.map((row) => [row.recipeId, row]),
    );
    const collectorRows =
      readCollectorResults && (catalogUsesCollector || currentLeague)
        ? await readCollectorResults(currentLeague?.id, recipeId)
        : [];
    const collectorEvaluations = new Map(
      collectorRows
        .filter(
          (row) => catalogUsesCollector || row.leagueId === currentLeague?.id,
        )
        .map((row) => [row.recipeId, row]),
    );
    return {
      currentLeague,
      maximumQuoteAgeMs,
      publishedAt: legacy?.cycle.publishedAt ?? null,
      captureIdFor(recipe: StoredRecipe) {
        const row = collectorEvaluations.get(recipe.id);
        return row?.recipeContentHash === recipe.contentHash
          ? row.result.methodCost?.source?.captureId
          : undefined;
      },
      status: refreshStatus(
        progress?.active?.status ?? progress?.published?.status,
      ),
      evaluationFor(recipe: StoredRecipe) {
        return readCollectorResults
          ? collectorEvaluation(
              recipe,
              collectorEvaluations.get(recipe.id),
              maximumQuoteAgeMs,
            )
          : currentEvaluation(
              recipe,
              legacyEvaluations.get(recipe.id),
              maximumQuoteAgeMs,
            );
      },
    };
  }

  return {
    async readCollectorReadiness(): Promise<CollectorReadinessResponse> {
      const now = new Date();
      const [recipes, market] = await Promise.all([
        repositories.recipes.listActive(),
        readMarket(),
      ]);
      const evidence =
        (await readReadiness?.(now, market.maximumQuoteAgeMs)) ?? [];
      const byRecipe = new Map(recipes.map((recipe) => [recipe.id, recipe]));
      return {
        evaluatedAt: now.toISOString(),
        targets: evidence.map((row) => {
          const { key, name, league, role, intervalMinutes, outputRecipeIds } =
            row.schedule;
          const evaluations = (
            outputRecipeIds.length
              ? outputRecipeIds.flatMap((id) => {
                  const recipe = byRecipe.get(id);
                  return recipe ? [recipe] : [];
                })
              : role === 'output' && row.schedule.captureId
                ? recipes.filter(
                    (recipe) =>
                      market.captureIdFor(recipe) === row.schedule.captureId,
                  )
                : []
          ).map((recipe) =>
            toEvaluation(recipe.id, market.evaluationFor(recipe)),
          );
          // A target is a candidate as soon as one method clears every gate.
          // Prefer a fresh comparable price if no method clears the cost gate.
          const choices = evaluations.map((evaluation) =>
            targetReadiness(row, now, market.maximumQuoteAgeMs, evaluation),
          );
          const readiness =
            choices.find((value) => value.level === 'preliminary-candidate') ??
            choices.find(
              (value) => value.comparableAsks && value.costVerified,
            ) ??
            choices.find((value) => value.comparableAsks) ??
            choices.find((value) => value.costVerified) ??
            targetReadiness(row, now, market.maximumQuoteAgeMs);
          return { key, name, league, role, intervalMinutes, readiness };
        }),
      };
    },

    async readCatalog(correlationId: string): Promise<CatalogResponse> {
      const [recipes, market] = await Promise.all([
        repositories.recipes.listActive(),
        readMarket(),
      ]);
      const now = new Date();
      const readiness = await readReadiness?.(now, market.maximumQuoteAgeMs);
      const byRecipe = new Map(
        readiness
          ?.filter((row) => row.schedule.role === 'output')
          .flatMap((row) =>
            row.schedule.outputRecipeIds.map((id) => [id, row] as const),
          ),
      );
      const byCapture = new Map(
        readiness
          ?.filter((row) => row.schedule.role === 'output')
          .flatMap((row) =>
            row.schedule.captureId
              ? [[row.schedule.captureId, row] as const]
              : [],
          ),
      );
      const entries = await Promise.all(
        recipes
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(async (recipe) => {
            const evaluation = market.evaluationFor(recipe);
            const snapshot = readCollectorResults
              ? null
              : await latestOutputSnapshot({
                  currentLeague: market.currentLeague,
                  evaluation,
                  maximumQuoteAgeMs: market.maximumQuoteAgeMs,
                  recipe,
                  repositories,
                  trade,
                });
            const entry = toCatalogEntry(
              recipe,
              readRecipeDocument(recipe),
              evaluation,
              presentationCatalog,
              snapshot,
            );
            const evidence =
              byRecipe.get(recipe.id) ??
              byCapture.get(market.captureIdFor(recipe) ?? '');
            return readReadiness
              ? {
                  ...entry,
                  readiness: evidence
                    ? targetReadiness(
                        evidence,
                        now,
                        market.maximumQuoteAgeMs,
                        entry.evaluation,
                      )
                    : null,
                }
              : entry;
          }),
      );
      if (readCollectorResults)
        return collectorResourceResponse(
          correlationId,
          { entries, pipeline: 'collector' as const },
          entries.map(({ evaluation }) => evaluation),
        );
      return resourceResponse(
        correlationId,
        { entries },
        market.publishedAt,
        market.status,
      );
    },

    async readRecipe(
      correlationId: string,
      recipeId: string,
    ): Promise<RecipeResponse> {
      const [recipe, market] = await Promise.all([
        repositories.recipes.findById(recipeId),
        readMarket(recipeId),
      ]);
      if (!recipe || !recipe.active) {
        throw new DomainError('PERSISTENCE_NOT_FOUND');
      }
      const { currentLeague, maximumQuoteAgeMs } = market;
      const definition = readRecipeDocument(recipe);
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
      const evaluation = market.evaluationFor(recipe);
      // The collector keys a target's schedule by this same query hash.
      const target =
        (readMarketActivity || readReadiness) && trade && currentLeague
          ? await generateRecipeMarketQuery(
              trade,
              definition,
              currentLeague.gggId,
            ).catch(() => null)
          : null;
      const now = new Date();
      const key =
        target && currentLeague
          ? await hashMarketQuery({ ...target, league: currentLeague.gggId })
          : null;
      const readiness =
        key && readReadiness
          ? (await readReadiness(now, maximumQuoteAgeMs)).find(
              (row) => row.schedule.key === key,
            )
          : null;
      const marketActivity = readiness
        ? readiness.activity
        : readMarketActivity && key && currentLeague
          ? await readMarketActivity(
              currentLeague.id,
              key,
              now,
              maximumQuoteAgeMs,
            )
          : null;
      const recipeDetail = toRecipeDetail(
        recipe,
        definition,
        evaluation,
        presentationCatalog,
      );
      const detail = {
        ...recipeDetail,
        ...(readMarketActivity ? { marketActivity } : {}),
        ...(readReadiness
          ? {
              readiness: readiness
                ? targetReadiness(
                    readiness,
                    now,
                    maximumQuoteAgeMs,
                    recipeDetail.evaluation,
                  )
                : null,
            }
          : {}),
        baseTradeUrl,
        snapshot: readCollectorResults
          ? null
          : await latestOutputSnapshot({
              currentLeague,
              evaluation,
              maximumQuoteAgeMs,
              recipe,
              repositories,
              trade,
            }),
      };
      return readCollectorResults
        ? collectorResourceResponse(correlationId, detail, [detail.evaluation])
        : resourceResponse(
            correlationId,
            detail,
            market.publishedAt,
            market.status,
          );
    },
  };
}

function collectorEvaluation(
  recipe: StoredRecipe,
  row: CollectorResultRow | undefined,
  maximumQuoteAgeMs?: number,
): ResourceEvaluation | undefined {
  if (row?.recipeContentHash !== recipe.contentHash) return;
  const parsed = recipeResultSchema.safeParse(row.result);
  if (!parsed.success) return;
  const result = parsed.data;
  const now = Date.now();
  const method = result.methodCost;
  const expired = (expiresAt: string, oldestInputAt: string) =>
    Date.parse(expiresAt) <= now ||
    (maximumQuoteAgeMs !== undefined &&
      Date.parse(oldestInputAt) + maximumQuoteAgeMs <= now);
  const stale = method && expired(method.expiresAt, method.oldestInputAt);
  const freshCraftCost =
    method &&
    method.craftExpiresAt &&
    method.craftInputAt &&
    result.expectedCraftCost !== null &&
    !expired(method.craftExpiresAt, method.craftInputAt);
  const methodCost = !stale
    ? method
    : freshCraftCost
      ? {
          ...method,
          source: undefined,
          saleEvidence: {
            comparableSellers: 0,
            reason:
              'The output quote expired. The verified craft inputs are still fresh.',
          },
        }
      : null;
  return {
    ...result,
    methodCost,
    evaluatedAt: row.evaluatedAt,
    lastSuccessfulAt:
      !stale && result.status === 'success' ? row.evaluatedAt : null,
    ...(stale
      ? {
          status: 'stale',
          estimatedSalePrice: null,
          expectedCraftCost: freshCraftCost ? result.expectedCraftCost : null,
          marginPercent: null,
          profit: null,
        }
      : {}),
  };
}

function collectorResourceResponse<T>(
  correlationId: string,
  data: T,
  evaluations: ApiRecipeEvaluation[],
) {
  const latest = (values: (string | null)[]) =>
    values
      .filter((at): at is string => at !== null)
      .sort()
      .at(-1);
  const publishedAt = latest(evaluations.map(({ evaluatedAt }) => evaluatedAt));
  if (!publishedAt) return resourceResponse(correlationId, data, null, 'idle');

  const lastSuccessfulAt = latest(
    evaluations.map((row) => row.lastSuccessfulAt),
  );
  const common = {
    correlationId,
    data,
    publishedAt,
    refreshStatus: 'idle' as const,
  };
  if (lastSuccessfulAt)
    return {
      ...common,
      lastSuccessfulAt,
      errorCode: null,
      isStale: false as const,
      state: 'success' as const,
    };

  const isStale =
    evaluations.some((row) => row.status === 'stale') &&
    !evaluations.some((row) => row.status === 'partial');
  return {
    ...common,
    lastSuccessfulAt: null,
    errorCode: isStale
      ? ('SNAPSHOT_EXPIRED' as const)
      : (evaluations.find((row) => row.errorCode)?.errorCode ??
        ('PUBLICATION_INCOMPLETE' as const)),
    isStale,
    state: 'partial' as const,
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
  definition: ReturnType<typeof validateRecipeDocument>,
  evaluation?: ResourceEvaluation,
  presentationCatalog?: ItemPresentationCatalog,
  snapshot?: CatalogEntry['snapshot'],
): CatalogEntry {
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
    recipe: toRecipeSummary(recipe, definition, evaluation),
    snapshot: snapshot ?? null,
  };
}

async function latestOutputSnapshot(input: {
  maximumQuoteAgeMs?: number | undefined;
  currentLeague: Awaited<ReturnType<Repositories['leagues']['findCurrent']>>;
  evaluation:
    | (ResourceEvaluation & { sourceSnapshotDedupeKey?: string | null })
    | undefined;
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
  const now = Date.now();
  if (
    !snapshot ||
    snapshot.expiresAt.getTime() <= now ||
    (input.maximumQuoteAgeMs !== undefined &&
      snapshot.capturedAt.getTime() + input.maximumQuoteAgeMs <= now) ||
    (input.evaluation?.sourceSnapshotDedupeKey &&
      snapshot.dedupeKey !== input.evaluation.sourceSnapshotDedupeKey)
  )
    return null;
  const listings = Array.isArray(snapshot.payload.listings)
    ? snapshot.payload.listings
    : [];
  const observed = listings.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    const price = row.price as Record<string, unknown> | undefined;
    const amount =
      typeof price?.amount === 'string' ? Number(price.amount) : price?.amount;
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
  });
  const exchange = savedTradeExchangeSchema.safeParse(
    input.evaluation?.methodCost?.marketExchange,
  );
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
      exchange.success && exchange.data.league === input.currentLeague.gggId
        ? revalueSavedTradeListings(observed, exchange.data)
        : observed,
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

function toRecipeSummary(
  recipe: StoredRecipe,
  definition: ReturnType<typeof validateRecipeDocument>,
  evaluation?: ResourceEvaluation,
) {
  return {
    category: recipe.category,
    craftMethod: recipe.craftMethod,
    patch: definition.patch,
    id: recipe.id,
    minimumCapital: price(evaluation?.expectedCraftCost, evaluation?.currency),
    summary: definition.summary ?? recipe.title,
    targetSignature: definition.targetSignature,
    tags: [...recipe.tags],
    title: recipe.title,
  };
}

const saleGradeSchema = recipeEvaluationSchema.pick({
  grade: true,
  gradeReasons: true,
});

function toEvaluation(
  recipeId: string,
  evaluation?: ResourceEvaluation,
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
  const savedBudget = record(evaluation.methodCost?.budget);
  const p50 = persistedPrice({
    amount: savedBudget?.p50,
    currency: savedBudget?.currency,
  });
  const p90 = persistedPrice({
    amount: savedBudget?.p90,
    currency: savedBudget?.currency,
  });
  const evaluationProfit = profit(evaluation.profit, evaluation.currency);
  const saleGrade = saleGradeSchema.safeParse({
    grade: saleEvidence?.grade,
    gradeReasons: saleEvidence?.gradeReasons,
  });
  const priceSource = recipePriceSourceSchema.safeParse({
    ...(typeof source?.captureId === 'string'
      ? { captureId: source.captureId }
      : {}),
    ...(typeof saleEvidence?.status === 'string'
      ? { comparable: saleEvidence.status === 'accepted' }
      : {}),
    capturedAt: source?.capturedAt,
    comparableSellers: saleEvidence?.comparableSellers ?? source?.sampleSize,
    coverage: source?.coverage ?? 'unknown',
  });
  return {
    ...(priceSource.success ? { source: priceSource.data } : {}),
    ...(evaluationProfit !== null && saleGrade.success && saleGrade.data.grade
      ? saleGrade.data
      : {}),
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
    budget: p50 && p90 ? { p50, p90 } : null,
    lastSuccessfulAt: evaluation.lastSuccessfulAt?.toISOString() ?? null,
    marginPercent: finiteNumber(evaluation.marginPercent),
    profit: evaluationProfit,
    recipeId,
    snapshotId: null,
    status: evaluation.status,
  };
}

function toRecipeDetail(
  recipe: StoredRecipe,
  definition: ReturnType<typeof validateRecipeDocument>,
  evaluation?: ResourceEvaluation,
  presentationCatalog?: ItemPresentationCatalog,
): RecipeDetailView {
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
    recipe: toRecipeSummary(recipe, definition, evaluation),
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
        budget: null,
        expectedCost: null,
        marketStatus: 'unavailable',
      },
    };
  }
  return withoutUnsupportedProfit(evaluation);
}

/** Minimum seller count applied to legacy evaluations without a grade. */
const minimumComparableSellers = 2;

/**
 * Old evaluations may rely on one seller or a mixed-currency result prefix.
 * All generated output queries include mixed currencies: only complete coverage
 * supports the cheapest ask. Keep costs, but withhold unsupported resale/ROI.
 */
function withoutUnsupportedProfit(evaluation: RecipeEvaluation) {
  const methodCost = evaluation.methodCost ?? {};
  const saleEvidence = record(methodCost.saleEvidence);
  const grade = saleEvidence?.grade;
  if (
    saleEvidence?.status === 'accepted' &&
    (grade === 'A' || grade === 'B' || grade === 'C')
  )
    return evaluation;
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
