import {
  aggregateMarketListings,
  type CanonicalJsonObject,
  type CanonicalJsonValue,
  DomainError,
  type DomainErrorCode,
  type MarketListing,
  type NewRecipeEvaluation,
  type Recipe,
  type RecipeEvaluation,
  type Repositories,
  calculateMethodMaterialEconomics,
  estimateSaleAsk,
  expectedMethodMaterialUsage,
  compareCraftWithAsk,
  gradeSaleEvidence,
  hashMarketQuery,
  transitionRefreshCycle,
  validateRecipeDocument,
} from '@poe-worksmith/domain';

import { z } from 'zod';
import {
  type RecipeMarketDependencies,
  comparableRecipeListings,
  requiresCompleteOutputCoverage,
} from './recipeMarket.js';
import type { Logger } from 'pino';
import type { Metrics } from './observability/metrics.js';
import {
  convertMarketQuote,
  revalueSavedTradeListings,
} from './marketCurrency.js';
import {
  verifyEconomySnapshot,
  type MarketEconomyRepository,
  type StoredMarketEconomySnapshot,
} from './marketEconomy.js';

const jsonValueSchema: z.ZodType<CanonicalJsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const jsonObjectSchema: z.ZodType<CanonicalJsonObject> = z.record(
  z.string(),
  jsonValueSchema,
);
const moneySchema = z.strictObject({
  amount: z.string().min(1),
  currency: z.string().min(1),
});
const listingSchema = z.strictObject({
  account: z.string().min(1),
  ageSeconds: z.number().int().nonnegative(),
  fee: moneySchema.nullable(),
  id: z.string().min(1),
  indexedAt: z.iso.datetime(),
  item: jsonObjectSchema,
  price: moneySchema,
});
export const snapshotPayloadSchema = z.object({
  coverage: z.enum(['complete', 'partial', 'unknown']).optional(),
  sortedPageComplete: z.boolean().optional(),
  sortedSampleComplete: z.boolean().optional(),
  listings: z.array(listingSchema),
  totalResults: z.number().int().nonnegative(),
});

type FreshEvaluation = Readonly<{
  confidence: 'low' | 'medium' | 'high';
  currency: string;
  estimatedSalePrice: string | null;
  expectedCraftCost: string | null;
  marginPercent: string | null;
  observationId: number | null;
  profit: string | null;
  sourceSnapshotDedupeKey: string | null;
  status?: 'success' | 'partial';
  methodCost?: Record<string, unknown>;
}>;

export type FreshRecipeEvaluator = (
  recipe: Recipe,
  context: {
    cycleId: string;
    league: string;
    leagueId: string;
    now: Date;
    repositories: Repositories;
  },
) => Promise<FreshEvaluation>;

export type CatalogPublicationReport = Readonly<{
  completedRecipes: number;
  evaluations: readonly RecipeEvaluation[];
  failedRecipes: number;
  leagueId: string;
  leagueName: string;
  published: boolean;
  publicationDiagnostic: 'CATALOG_PUBLICATION_SKIPPED_LEAGUE_CHANGED' | null;
  refreshCycleId: string;
  staleFallbacks: number;
}>;

export async function evaluateAndPublishCatalog(
  repositories: Repositories,
  options: {
    cycleId: string;
    evaluateRecipe?: FreshRecipeEvaluator;
    allowMissingOutput?: boolean;
    league: string;
    leagueName?: string;
    now?: Date;
    marketDependencies?: RecipeMarketDependencies;
    economy?: Pick<MarketEconomyRepository, 'find' | 'latest'> &
      Partial<Pick<MarketEconomyRepository, 'listAttempts'>>;
    logger?: Logger;
    metrics?: Metrics;
    maximumQuoteAgeMs?: number;
    freshnessWarningMs?: number;
    recipeId?: string;
    signal?: AbortSignal;
  },
): Promise<CatalogPublicationReport> {
  const now = options.now ?? new Date();
  const league = options.league.trim();
  const leagueName = options.leagueName?.trim() || league;
  if (
    options.cycleId.trim().length === 0 ||
    league.length === 0 ||
    !Number.isFinite(now.getTime())
  ) {
    throw new DomainError('REFRESH_STATE_INVALID');
  }
  let cycle = await repositories.cycles.findById(options.cycleId);
  if (!cycle) throw new DomainError('PERSISTENCE_NOT_FOUND');
  if (
    cycle.status === 'completed' ||
    cycle.status === 'published' ||
    cycle.status === 'failed'
  ) {
    const evaluations = await repositories.evaluations.listByCycle(cycle.id);
    return {
      completedRecipes: cycle.completedRecipes,
      evaluations,
      failedRecipes: cycle.failedRecipes,
      leagueId: cycle.leagueId,
      leagueName,
      published: cycle.status === 'published',
      publicationDiagnostic:
        cycle.errorMessage === 'CATALOG_PUBLICATION_SKIPPED_LEAGUE_CHANGED'
          ? cycle.errorMessage
          : null,
      refreshCycleId: cycle.id,
      staleFallbacks: evaluations.filter(({ status }) => status === 'stale')
        .length,
    };
  }
  if (
    cycle.completedQueries + cycle.failedQueries !== cycle.totalQueries ||
    !['queued', 'running'].includes(cycle.status)
  ) {
    throw new DomainError('REFRESH_INCOMPLETE');
  }
  if (cycle.status === 'queued') {
    cycle = await repositories.cycles.save(
      transitionRefreshCycle(cycle, 'running', now),
    );
  }

  const allRecipes = await repositories.recipes.listActive();
  const recipes = allRecipes
    .filter((recipe) => !options.recipeId || recipe.id === options.recipeId)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (recipes.length !== cycle.totalRecipes) {
    throw new DomainError('REFRESH_STATE_INVALID');
  }
  const previous = await repositories.catalog.getPublished();
  const previousByRecipe = new Map(
    previous?.cycle.leagueId === cycle.leagueId
      ? previous.evaluations.map((evaluation) => [
          evaluation.recipeId,
          evaluation,
        ])
      : [],
  );
  if (options.recipeId) {
    for (const previous of previousByRecipe.values()) {
      if (
        previous.recipeId === options.recipeId ||
        !allRecipes.some(
          (r) =>
            r.id === previous.recipeId &&
            r.contentHash === previous.methodCost?.recipeContentHash,
        )
      )
        continue;
      const carried = { ...previous, id: undefined, refreshCycleId: cycle.id };
      await repositories.evaluations.save(carried);
    }
  }
  const attempts = (await options.economy?.listAttempts?.()) ?? [];
  const verified = (snapshot: StoredMarketEconomySnapshot | null) =>
    verifyEconomySnapshot(snapshot, attempts, now);
  const economySummary = await options.economy?.latest(league, 'Currency');
  const currencyExchange = verified(
    economySummary ? await options.economy!.find(economySummary.id) : null,
  );
  const materialEconomies = new Map<string, StoredMarketEconomySnapshot>();
  for (const category of [
    'Currency',
    'Essence',
    'Fossil',
    'Resonator',
  ] as const) {
    const latest = await options.economy?.latest(league, category);
    const snapshot = verified(
      latest ? await options.economy!.find(latest.id) : null,
    );
    if (
      snapshot &&
      snapshot.league === league &&
      now.getTime() >= Date.parse(snapshot.verifiedAt ?? snapshot.capturedAt) &&
      now.getTime() - Date.parse(snapshot.verifiedAt ?? snapshot.capturedAt) <=
        (options.maximumQuoteAgeMs ?? 30 * 60_000)
    )
      materialEconomies.set(category, snapshot);
  }
  const evaluateRecipe =
    options.evaluateRecipe ??
    ((recipe, context) =>
      evaluateFreshRecipe(
        recipe,
        context,
        options.marketDependencies,
        currencyExchange,
        [...materialEconomies.values()],
        options.maximumQuoteAgeMs,
        options.allowMissingOutput,
        options.freshnessWarningMs,
      ));
  const evaluations: RecipeEvaluation[] = [];
  let completedRecipes = 0;
  let failedRecipes = 0;
  let staleFallbacks = 0;

  for (const recipe of recipes) {
    options.signal?.throwIfAborted();
    let evaluation: NewRecipeEvaluation;
    try {
      const fresh = await evaluateRecipe(recipe, {
        cycleId: cycle.id,
        league,
        leagueId: cycle.leagueId,
        now,
        repositories,
      });
      evaluation = {
        ...fresh,
        errorCode: null,
        evaluatedAt: now,
        lastSuccessfulAt: fresh.status === 'partial' ? null : now,
        leagueId: cycle.leagueId,
        recipeId: recipe.id,
        refreshCycleId: cycle.id,
        status: fresh.status ?? 'success',
        methodCost: {
          ...fresh.methodCost,
          recipeContentHash: recipe.contentHash,
        },
      };
      completedRecipes += 1;
    } catch (cause) {
      const error = toDomainError(cause);
      const fallback = previousByRecipe.get(recipe.id);
      evaluation =
        reusableEvaluation(fallback) &&
        fallback.methodCost?.recipeContentHash === recipe.contentHash
          ? {
              confidence: fallback.confidence,
              currency: fallback.currency,
              errorCode: error.code,
              estimatedSalePrice: fallback.estimatedSalePrice,
              evaluatedAt: now,
              expectedCraftCost: fallback.expectedCraftCost,
              lastSuccessfulAt:
                fallback.lastSuccessfulAt ??
                (fallback.status === 'success' ? fallback.evaluatedAt : null),
              leagueId: cycle.leagueId,
              marginPercent: fallback.marginPercent,
              observationId: fallback.observationId,
              profit: fallback.profit,
              recipeId: recipe.id,
              refreshCycleId: cycle.id,
              sourceSnapshotDedupeKey: fallback.sourceSnapshotDedupeKey,
              methodCost: {
                ...fallback.methodCost,
                oldestInputAt:
                  typeof fallback.methodCost?.oldestInputAt === 'string'
                    ? fallback.methodCost.oldestInputAt
                    : (
                        fallback.lastSuccessfulAt ?? fallback.evaluatedAt
                      ).toISOString(),
              },
              status: 'stale',
            }
          : {
              confidence: null,
              currency: null,
              errorCode: error.code,
              estimatedSalePrice: null,
              evaluatedAt: now,
              expectedCraftCost: null,
              lastSuccessfulAt: null,
              leagueId: cycle.leagueId,
              marginPercent: null,
              observationId: null,
              profit: null,
              recipeId: recipe.id,
              refreshCycleId: cycle.id,
              sourceSnapshotDedupeKey: null,
              methodCost: null,
              status: 'error',
            };
      failedRecipes += 1;
      if (evaluation.status === 'stale') staleFallbacks += 1;
    }
    evaluations.push(await repositories.evaluations.save(evaluation));
    options.logger?.info(
      {
        recipeId: recipe.id,
        status: evaluation.status,
        ...(evaluation.errorCode ? { errorCode: evaluation.errorCode } : {}),
      },
      'recipe.evaluated',
    );
    options.metrics?.recipeEvaluations.inc({ status: evaluation.status });
  }

  cycle = await repositories.cycles.save({
    ...cycle,
    completedRecipes,
    failedRecipes,
  });
  const meetsThreshold =
    cycle.totalRecipes > 0 &&
    cycle.completedRecipes * 100 >= cycle.totalRecipes * 95;
  if (meetsThreshold) {
    options.signal?.throwIfAborted();
    const published = await repositories.cycles.publish(cycle.id, now);
    options.logger?.info(
      { published },
      published
        ? 'publication.completed'
        : 'publication.skipped_league_mismatch',
    );
    return {
      completedRecipes,
      evaluations,
      failedRecipes,
      leagueId: cycle.leagueId,
      leagueName,
      published,
      publicationDiagnostic: published
        ? null
        : 'CATALOG_PUBLICATION_SKIPPED_LEAGUE_CHANGED',
      refreshCycleId: cycle.id,
      staleFallbacks,
    };
  } else {
    await repositories.cycles.save(
      transitionRefreshCycle(
        cycle,
        'failed',
        now,
        'Publication success threshold was not met.',
      ),
    );
  }

  return {
    completedRecipes,
    evaluations,
    failedRecipes,
    leagueId: cycle.leagueId,
    leagueName,
    published: meetsThreshold,
    publicationDiagnostic: null,
    refreshCycleId: cycle.id,
    staleFallbacks,
  };
}

async function evaluateFreshRecipe(
  recipe: Recipe,
  context: {
    cycleId: string;
    league: string;
    leagueId: string;
    now: Date;
    repositories: Repositories;
  },
  marketDependencies?: RecipeMarketDependencies,
  currencyExchange?: StoredMarketEconomySnapshot | null,
  materialEconomies: readonly StoredMarketEconomySnapshot[] = [],
  maximumQuoteAgeMs = 30 * 60_000,
  allowMissingOutput = false,
  freshnessWarningMs = 60 * 60_000,
): Promise<FreshEvaluation> {
  let definition;
  try {
    definition = validateRecipeDocument(recipe.definition);
  } catch (cause) {
    throw new DomainError('RECIPE_INVALID', { cause });
  }
  if (!marketDependencies) throw new DomainError('RECIPE_INVALID');
  const dependencies = await marketDependencies({
    league: context.league,
    recipe: definition,
  });
  const baseDependency = dependencies.find(({ kind }) => kind === 'base');
  const targetDependency = dependencies.find(({ kind }) => kind === 'target');
  if (!baseDependency?.query || !targetDependency?.query)
    throw new DomainError('RECIPE_INVALID');
  const marketContext = {
    ...context,
    currencyExchange: currencyExchange ?? null,
  };
  const readMarket = async (
    query: import('./recipeMarket.js').RecipeMarketQuery,
    requiredStock?: number,
    allowMissing = true,
  ) => {
    try {
      const market = await resolveMarket(
        query,
        marketContext,
        requiredStock,
        maximumQuoteAgeMs,
      );
      return market;
    } catch (error) {
      if (
        allowMissing &&
        error instanceof DomainError &&
        ['SNAPSHOT_MISSING', 'SNAPSHOT_EXPIRED'].includes(error.code)
      )
        return null;
      throw error;
    }
  };
  const optionalMarket = async (
    query: import('./recipeMarket.js').RecipeMarketQuery,
    stock?: number,
  ) => {
    const market = await readMarket(query, stock);
    return market?.currencyAvailable ? market : null;
  };
  const usage = expectedMethodMaterialUsage(definition.craft);
  const base = await optionalMarket(baseDependency.query);
  const materialMarkets = await Promise.all(
    dependencies
      .filter(({ kind }) => kind === 'material')
      .map(async (material) => {
        const result = material.query
          ? await optionalMarket(
              material.query,
              usage?.[material.materialId!] ?? Infinity,
            )
          : null;
        return {
          capturedAt: result?.snapshotCapturedAt ?? context.now,
          expiresAt: result?.snapshotExpiresAt ?? null,
          conversionAt: result?.conversionAt ?? null,
          id: material.materialId!,
          price: result?.aggregation.cheapest ?? null,
          topOfBook: result?.topOfBook ?? null,
        };
      }),
  );
  const output = await readMarket(
    targetDependency.query,
    undefined,
    allowMissingOutput,
  );
  const currency = output?.aggregation.sampleSize
    ? output.aggregation.currency
    : (base?.aggregation.currency ?? 'chaos');
  const conversionEvidence = new Map<
    string,
    NonNullable<
      NonNullable<Awaited<ReturnType<typeof convertMarketQuote>>>['exchange']
    >
  >();
  const convertPrice = async (
    price: { amount: string; currency: string } | null,
    capturedAt: Date,
    itemId: string,
  ) => {
    if (!price) return null;
    if (price.currency === currency) {
      conversionEvidence.delete(itemId);
      return price;
    }
    if (!currencyExchange || !['chaos', 'divine'].includes(currency))
      return null;
    const converted = await convertMarketQuote({
      money: price,
      currency: currency as 'chaos' | 'divine',
      target: { league: context.league },
      capturedAt: capturedAt.toISOString(),
      exchangeSnapshotId: currencyExchange.id,
      economy: {
        find: async (id) =>
          id === currencyExchange.id ? currencyExchange : null,
      },
      now: context.now.getTime(),
      dataKind: 'observed',
    });
    if (converted?.exchange) conversionEvidence.set(itemId, converted.exchange);
    return converted?.money ?? null;
  };
  const basePrice = await convertPrice(
    base?.aggregation.cheapest ?? null,
    base?.snapshotCapturedAt ?? context.now,
    'base',
  );
  const materialEntries = await Promise.all(
    materialMarkets.map(
      async ({ capturedAt, id, price, topOfBook }) =>
        [id, await convertPrice(price ?? topOfBook, capturedAt, id)] as const,
    ),
  );
  const materialPriceMap = Object.fromEntries(materialEntries);
  const tradeMaterialIds = new Set(
    materialMarkets.filter((m) => materialPriceMap[m.id]).map((m) => m.id),
  );
  const usedMaterialEconomies = new Set<StoredMarketEconomySnapshot>();
  const bulkSupported = new Set(
    materialMarkets.filter((m) => m.price).map((m) => m.id),
  );
  const materialEvidence: Record<string, unknown> = Object.fromEntries(
    materialMarkets
      .filter((m) => m.price ?? m.topOfBook)
      .map((m) => [
        m.id,
        {
          itemId: m.id,
          league: context.league,
          source: 'poe-trade-exchange',
          priceBasis: 'asking',
          currency: (m.price ?? m.topOfBook)!.currency,
          bulkSupported: Boolean(m.price),
          capturedAt: m.capturedAt.toISOString(),
        },
      ]),
  );
  if (basePrice && base)
    materialEvidence.base = {
      itemId: 'base',
      league: context.league,
      source: 'poe-trade',
      priceBasis: 'asking',
      currency: basePrice.currency,
      capturedAt: base.snapshotCapturedAt.toISOString(),
      sortedSampleComplete: base.sortedSampleComplete,
      totalResults: base.aggregation.totalListings,
    };
  for (const dependency of dependencies.filter((d) => d.kind === 'material')) {
    const id = dependency.materialId!;
    if (id === 'chaos-orb') {
      const unitPrice = await convertPrice(
        { amount: '1', currency: 'chaos' },
        context.now,
        id,
      );
      if (unitPrice) {
        materialPriceMap[id] = unitPrice;
        tradeMaterialIds.delete(id);
        bulkSupported.add(id);
        materialEvidence[id] = {
          itemId: id,
          league: context.league,
          source: 'currency-unit',
          bulkSupported: true,
          currency: unitPrice.currency,
          capturedAt: context.now.toISOString(),
        };
      }
      continue;
    }
    // Ninja is the bulk estimate; a single exchange offer must cover expected consumption.

    for (const snapshot of materialEconomies) {
      const line = snapshot.lines.find((line) => line.detailsId === id);
      if (!line || line.price.amount === null) continue;
      const converted = await convertPrice(
        { amount: String(line.price.amount), currency: line.price.currency },
        new Date(snapshot.verifiedAt ?? snapshot.capturedAt),
        id,
      );
      if (!converted) continue;
      materialPriceMap[id] = converted;
      tradeMaterialIds.delete(id);
      usedMaterialEconomies.add(snapshot);
      bulkSupported.add(id);
      materialEvidence[id] = {
        itemId: id,
        league: snapshot.league,
        source: snapshot.source,
        priceBasis: 'economy-estimate',
        bulkSupported: true,
        currency: line.price.currency,
        capturedAt: snapshot.capturedAt,
        ...(snapshot.verifiedAt ? { verifiedAt: snapshot.verifiedAt } : {}),
        snapshotId: snapshot.id,
      };
      break;
    }
  }
  const saleAsk = output?.currencyAvailable
    ? estimateSaleAsk(output.aggregation)
    : null;
  const materialEconomics = calculateMethodMaterialEconomics({
    currency,
    materialPrices: materialPriceMap,
    method: definition.craft,
  });
  const evidenceValid =
    definition.verification.status === 'verified' &&
    definition.verification.leagues.includes(context.league) &&
    definition.craft.expectedExecutions?.every(
      ({ evidence }) => evidence.patch === definition.patch,
    ) &&
    definition.craft.baseConsumption?.evidence.patch === definition.patch;
  const salePrice = saleAsk?.price?.amount ?? null;
  const comparableSellers = output?.aggregation.sampleSize ?? 0;
  const coverageBlocked =
    output &&
    output.coverage !== 'complete' &&
    (requiresCompleteOutputCoverage(targetDependency.query.query) ||
      !output.sortedSampleComplete);
  const saleStatus = definition.verification.profitBlockedReason
    ? 'unverified_output_value'
    : !output?.currencyAvailable
      ? 'unavailable_currency'
      : coverageBlocked
        ? 'insufficient_coverage'
        : comparableSellers >= minimumComparableSellers
          ? 'accepted'
          : 'insufficient_sellers';
  const usedTradeMaterials = materialMarkets.filter((m) =>
    tradeMaterialIds.has(m.id),
  );
  const inputTimes = [
    context.now.getTime(),
    ...(output ? [output.snapshotCapturedAt.getTime()] : []),
    ...(base ? [base.snapshotCapturedAt.getTime()] : []),
    ...usedTradeMaterials.map((m) => m.capturedAt.getTime()),
    ...[...usedMaterialEconomies].map((s) =>
      Date.parse(s.verifiedAt ?? s.capturedAt),
    ),
    ...[...conversionEvidence.values()].map((e) => Date.parse(e.verifiedAt)),
    ...[
      output?.currencyAvailable ? output.conversionAt : null,
      base?.conversionAt,
      ...usedTradeMaterials.map((m) => m.conversionAt),
    ].flatMap((at) => (at ? [at.getTime()] : [])),
  ];
  const oldestInputAt = Math.min(...inputTimes);
  const expiresAt = Math.min(
    output?.snapshotExpiresAt.getTime() ?? Infinity,
    base?.snapshotExpiresAt.getTime() ?? Infinity,
    ...usedTradeMaterials.map((m) => m.expiresAt?.getTime() ?? Infinity),
    oldestInputAt + maximumQuoteAgeMs,
  );
  const inputsFresh = expiresAt > context.now.getTime();
  const comparison = compareCraftWithAsk({
    basePrice,
    currency,
    materialCost:
      evidenceValid &&
      usage &&
      Object.keys(usage).every((id) => bulkSupported.has(id))
        ? materialEconomics.expectedCost
        : null,
    expectedBases: evidenceValid
      ? (definition.craft.baseConsumption?.expectedBases ?? null)
      : null,
    ask:
      saleStatus === 'accepted' && inputsFresh
        ? (saleAsk?.price ?? null)
        : null,
  });
  const { expectedCraftCost } = comparison;
  const gradedEvidence =
    output && comparison.profit !== null
      ? gradeSaleEvidence({
          sellers: comparableSellers,
          coverage: output.coverage,
          sortedSampleComplete: output.sortedSampleComplete,
          oldestInputAgeMs: context.now.getTime() - oldestInputAt,
          freshnessWarningMs,
          ignoredOutliers: saleAsk?.ignoredOutliers ?? 0,
        })
      : null;
  const saleBlockedReason = {
    unverified_output_value: definition.verification.profitBlockedReason,
    unavailable_currency: output
      ? 'A matching ask has no verified, fresh currency conversion.'
      : 'No fresh Trade observation for this crafted item.',
    insufficient_coverage:
      'Incomplete output coverage: Trade order may differ from converted prices. Refresh a narrower target before deriving ROI.',
    insufficient_sellers: 'No matching Trade sellers for this crafted item.',
    accepted: !inputsFresh
      ? 'At least one market input has expired.'
      : expectedCraftCost === null
        ? 'Complete, verified craft cost evidence is unavailable.'
        : undefined,
  }[saleStatus];
  const methodCost = {
    ...materialEconomics,
    recipeContentHash: recipe.contentHash,
    oldestInputAt: new Date(oldestInputAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    ...(output
      ? {
          source: {
            capturedAt: output.snapshotCapturedAt.toISOString(),
            sampleSize: output.aggregation.sampleSize,
            priceBasis: 'asking',
            coverage: output.coverage,
            sortedPageComplete: output.sortedPageComplete,
            sortedSampleComplete: output.sortedSampleComplete,
            currencyAvailable: output.currencyAvailable,
          },
        }
      : {}),
    marketStatus: !output
      ? 'unavailable'
      : output.coverage !== 'complete'
        ? 'partial'
        : output.aggregation.sampleSize
          ? 'priced'
          : 'empty',
    saleEvidence: {
      comparableSellers,
      ignoredOutliers: saleAsk?.ignoredOutliers ?? 0,
      minimumComparableSellers,
      saleBasis: saleAsk?.basis ?? 'none',
      status: saleStatus,
      ...(saleBlockedReason ? { reason: saleBlockedReason } : {}),
      ...(gradedEvidence
        ? { grade: gradedEvidence.grade, gradeReasons: gradedEvidence.reasons }
        : {}),
    },
    materialEvidence,
    baseCost: basePrice,
    expectedBases: evidenceValid
      ? (definition.craft.baseConsumption?.expectedBases ?? null)
      : null,
    currencyExchange: conversionEvidence.values().next().value ?? null,
    ...(output?.marketExchange
      ? { marketExchange: output.marketExchange }
      : {}),
    expectedCost:
      expectedCraftCost === null
        ? null
        : { amount: expectedCraftCost, currency },
  };
  const observations = output
    ? await context.repositories.observations.listRecent(
        output.marketQueryId,
        context.leagueId,
        output.snapshotCapturedAt,
      )
    : [];
  const observation = observations.find(
    ({ observedAt }) =>
      observedAt.getTime() === output?.snapshotCapturedAt.getTime(),
  );
  return {
    confidence:
      gradedEvidence?.grade === 'A'
        ? 'high'
        : gradedEvidence?.grade === 'B'
          ? 'medium'
          : 'low',
    currency,
    estimatedSalePrice: salePrice,
    expectedCraftCost,
    marginPercent: comparison.marginPercent,
    observationId: observation?.id ?? null,
    profit: comparison.profit,
    sourceSnapshotDedupeKey: output?.snapshotDedupeKey ?? null,
    status: comparison.profit === null ? 'partial' : 'success',
    methodCost,
  };
}

async function resolveMarket(
  tradeQuery: import('./recipeMarket.js').RecipeMarketQuery,
  context: {
    leagueId: string;
    league: string;
    now: Date;
    repositories: Repositories;
    currencyExchange?: StoredMarketEconomySnapshot | null;
  },
  requiredStock?: number,
  maximumQuoteAgeMs = 30 * 60_000,
) {
  const canonicalHash = await hashMarketQuery({
    league: context.league,
    provider: tradeQuery.provider,
    query: tradeQuery.query,
    schemaVersion: tradeQuery.schemaVersion,
  });
  const marketQuery =
    await context.repositories.marketQueries.findByCanonicalHash(canonicalHash);
  if (!marketQuery) throw new DomainError('SNAPSHOT_MISSING');
  const snapshot = await context.repositories.snapshots.findLatest(
    marketQuery.id,
    context.leagueId,
  );
  if (!snapshot) throw new DomainError('SNAPSHOT_MISSING');
  if (
    snapshot.expiresAt <= context.now ||
    snapshot.capturedAt.getTime() + maximumQuoteAgeMs <= context.now.getTime()
  ) {
    throw new DomainError('SNAPSHOT_EXPIRED');
  }
  const payload = snapshotPayloadSchema.safeParse(snapshot.payload);
  if (!payload.success) {
    throw new DomainError('SNAPSHOT_INVALID', { cause: payload.error });
  }
  let listings: MarketListing[] = payload.data.listings.map((listing) => ({
    ...listing,
    indexedAt: new Date(listing.indexedAt),
  }));
  const latestRate = context.currencyExchange;
  const rateAt = latestRate
    ? Date.parse(latestRate.verifiedAt ?? latestRate.capturedAt)
    : 0;
  let marketExchange = null;
  if (
    snapshot.dedupeKey.startsWith('scheduled-trade:') &&
    latestRate &&
    rateAt <= context.now.getTime() &&
    rateAt + maximumQuoteAgeMs > context.now.getTime()
  ) {
    const rate = await convertMarketQuote({
      money: { amount: '1', currency: 'divine' },
      currency: 'chaos',
      target: { league: context.league },
      capturedAt: snapshot.capturedAt.toISOString(),
      exchangeSnapshotId: latestRate.id,
      economy: { find: async () => latestRate },
      now: context.now.getTime(),
      dataKind: 'observed',
    });
    if (rate?.exchange) {
      const repriced = revalueSavedTradeListings(listings, rate.exchange);
      if (repriced.some((row, index) => row !== listings[index])) {
        listings = repriced;
        marketExchange = rate.exchange;
      }
    }
  }
  // An unconverted matching ask could be the true floor of this sorted sample.
  const unconverted = Boolean(
    tradeQuery.query.handbookTarget &&
    (listings.some(
      (row) => !['chaos', 'divine'].includes(row.price.currency),
    ) ||
      comparableRecipeListings(
        tradeQuery.query,
        listings.filter((row) => row.price.currency === 'divine'),
        snapshot.capturedAt,
        context.now,
        'divine',
      ).length > 0),
  );
  listings = comparableRecipeListings(
    tradeQuery.query,
    listings,
    snapshot.capturedAt,
    context.now,
  );
  const conversionTimes = listings.flatMap(({ item }) => {
    if (!item.exchange) return [];
    const exchange = jsonObjectSchema.safeParse(item.exchange);
    if (!exchange.success || exchange.data.league !== context.league)
      return [0];
    const value = exchange.data.verifiedAt ?? exchange.data.capturedAt;
    let at = typeof value === 'string' ? Date.parse(value) : NaN;
    // Revalidation proves the same immutable rate; it does not reprice the listing.
    const current = context.currencyExchange;
    if (
      current &&
      current.id === exchange.data.snapshotId &&
      current.league === context.league
    ) {
      at = Math.max(at, Date.parse(current.verifiedAt ?? current.capturedAt));
    }
    return [Number.isFinite(at) && at <= context.now.getTime() ? at : 0];
  });
  const conversionAt = conversionTimes.length
    ? new Date(Math.min(...conversionTimes))
    : null;
  const currencyAvailable =
    !unconverted &&
    (!conversionAt ||
      conversionAt.getTime() + maximumQuoteAgeMs > context.now.getTime());
  const topOfBook = aggregateMarketListings({
    currency: listings[0]?.price.currency ?? 'unknown',
    listings,
    totalListings: payload.data.totalResults,
  }).cheapest;
  if (requiredStock !== undefined)
    listings = listings.filter(
      (row) =>
        typeof row.item.stock === 'number' && row.item.stock >= requiredStock,
    );
  const currency = tradeQuery.query.handbookTarget
    ? 'chaos'
    : (listings[0]?.price.currency ?? 'unknown');
  const aggregation = aggregateMarketListings({
    currency,
    listings:
      tradeQuery.query.handbookTarget &&
      payload.data.coverage !== 'complete' &&
      (requiresCompleteOutputCoverage(tradeQuery.query) ||
        (!payload.data.sortedPageComplete &&
          !payload.data.sortedSampleComplete))
        ? []
        : listings,
    totalListings: payload.data.totalResults,
  });
  return {
    aggregation,
    topOfBook,
    coverage: currencyAvailable
      ? (payload.data.coverage ?? 'unknown')
      : 'partial',
    sortedPageComplete:
      currencyAvailable &&
      !requiresCompleteOutputCoverage(tradeQuery.query) &&
      (payload.data.sortedPageComplete ?? false),
    sortedSampleComplete:
      currencyAvailable &&
      !requiresCompleteOutputCoverage(tradeQuery.query) &&
      (payload.data.sortedSampleComplete ?? false),
    currencyAvailable,
    conversionAt,
    marketExchange,
    snapshotExpiresAt: snapshot.expiresAt,
    marketQueryId: marketQuery.id,
    snapshotCapturedAt: snapshot.capturedAt,
    snapshotDedupeKey: snapshot.dedupeKey,
  };
}

function reusableEvaluation(
  evaluation: RecipeEvaluation | undefined,
): evaluation is RecipeEvaluation & {
  currency: string;
  estimatedSalePrice: string;
} {
  return Boolean(
    evaluation?.currency &&
    evaluation.estimatedSalePrice &&
    ['success', 'stale', 'partial'].includes(evaluation.status),
  );
}

const minimumComparableSellers = 1;

function toDomainError(cause: unknown): DomainError<DomainErrorCode> {
  return cause instanceof DomainError
    ? cause
    : new DomainError('CALCULATION_FAILED', { cause });
}
