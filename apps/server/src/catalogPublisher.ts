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
  expectedMethodMaterialUsage,
  compareCraftWithAsk,
  hashMarketQuery,
  transitionRefreshCycle,
  validateRecipeDocument,
} from '@poe-worksmith/domain';

import { z } from 'zod';
import {
  type RecipeMarketDependencies,
  comparableRecipeListings,
} from './recipeMarket.js';
import type { Logger } from 'pino';
import type { Metrics } from './observability/metrics.js';
import { convertMarketQuote } from './marketCurrency.js';
import type {
  MarketEconomyRepository,
  StoredMarketEconomySnapshot,
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
const snapshotPayloadSchema = z.object({
  coverage: z.enum(['complete', 'partial', 'unknown']).optional(),
  sortedPageComplete: z.boolean().optional(),
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
    league: string;
    leagueName?: string;
    now?: Date;
    marketDependencies?: RecipeMarketDependencies;
    economy?: Pick<MarketEconomyRepository, 'find' | 'latest'> &
      Partial<Pick<MarketEconomyRepository, 'listAttempts'>>;
    logger?: Logger;
    metrics?: Metrics;
    maximumQuoteAgeMs?: number;
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
  const verified = (snapshot: StoredMarketEconomySnapshot | null) => {
    if (!snapshot) return null;
    // A completed HTTP attempt verifies the old payload; cache reads never advance freshness.
    const checks = attempts.filter(
      (a) =>
        a.snapshotId === snapshot.id &&
        a.league === snapshot.league &&
        a.category === snapshot.category &&
        a.status === 'succeeded' &&
        (a.cacheStatus === 'fetched' || a.cacheStatus === 'revalidated') &&
        a.completedAt &&
        Date.parse(a.completedAt) <= now.getTime() &&
        Date.parse(a.startedAt) <= Date.parse(a.completedAt),
    );
    const time = Math.max(
      Date.parse(snapshot.capturedAt),
      ...checks.map((a) => Date.parse(a.startedAt)),
    );
    return { ...snapshot, verifiedAt: new Date(time).toISOString() };
  };
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
                fallback.lastSuccessfulAt ?? fallback.evaluatedAt,
              leagueId: cycle.leagueId,
              marginPercent: fallback.marginPercent,
              observationId: fallback.observationId,
              profit: fallback.profit,
              recipeId: recipe.id,
              refreshCycleId: cycle.id,
              sourceSnapshotDedupeKey: fallback.sourceSnapshotDedupeKey,
              methodCost: fallback.methodCost ?? null,
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
  const optionalMarket = async (
    query: import('./recipeMarket.js').RecipeMarketQuery,
    requiredStock?: number,
  ) => {
    try {
      return await resolveMarket(query, context, requiredStock);
    } catch (error) {
      if (
        error instanceof DomainError &&
        ['SNAPSHOT_MISSING', 'SNAPSHOT_EXPIRED'].includes(error.code)
      )
        return null;
      throw error;
    }
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
          id: material.materialId!,
          price: result?.aggregation.cheapest ?? null,
          topOfBook: result?.topOfBook ?? null,
        };
      }),
  );
  const output = await resolveMarket(targetDependency.query, context);
  const currency = output?.aggregation.sampleSize
    ? output?.aggregation.currency
    : (base?.aggregation.currency ?? 'chaos');
  const conversionEvidence: NonNullable<
    Awaited<ReturnType<typeof convertMarketQuote>>
  >['exchange'][] = [];
  const convertPrice = async (
    price: { amount: string; currency: string } | null,
    capturedAt: Date,
  ) => {
    if (!price) return null;
    if (!currencyExchange || !['chaos', 'divine'].includes(currency))
      return price.currency === currency ? price : null;
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
    if (converted?.exchange) conversionEvidence.push(converted.exchange);
    return converted?.money ?? null;
  };
  const basePrice = await convertPrice(
    base?.aggregation.cheapest ?? null,
    base?.snapshotCapturedAt ?? context.now,
  );
  const materialEntries = await Promise.all(
    materialMarkets.map(
      async ({ capturedAt, id, price, topOfBook }) =>
        [id, await convertPrice(price ?? topOfBook, capturedAt)] as const,
    ),
  );
  const materialPriceMap = Object.fromEntries(materialEntries);
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
    };
  for (const dependency of dependencies.filter((d) => d.kind === 'material')) {
    const id = dependency.materialId!;
    if (id === 'chaos-orb') {
      const unitPrice = await convertPrice(
        { amount: '1', currency: 'chaos' },
        context.now,
      );
      if (unitPrice) {
        materialPriceMap[id] = unitPrice;
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
      );
      if (!converted) continue;
      materialPriceMap[id] = converted;
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
  const outputEstimate = output?.aggregation.estimators.find(
    ({ id }) => id === 'cheapest',
  )?.price;
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
  const salePrice = outputEstimate?.amount ?? null;
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
    ask: outputEstimate ?? null,
  });
  const { expectedCraftCost } = comparison;
  const methodCost = {
    ...materialEconomics,
    recipeContentHash: recipe.contentHash,
    oldestInputAt: new Date(
      Math.min(
        output?.snapshotCapturedAt.getTime() ?? Infinity,
        base?.snapshotCapturedAt.getTime() ?? Infinity,
        ...materialEconomies.map((s) =>
          Date.parse(s.verifiedAt ?? s.capturedAt),
        ),
        currencyExchange
          ? Date.parse(
              currencyExchange.verifiedAt ?? currencyExchange.capturedAt,
            )
          : Infinity,
        context.now.getTime(),
      ),
    ).toISOString(),
    expiresAt: new Date(
      Math.min(
        output?.snapshotExpiresAt.getTime() ?? Infinity,
        base?.snapshotExpiresAt.getTime() ?? Infinity,
        output
          ? output.snapshotCapturedAt.getTime() + maximumQuoteAgeMs
          : Infinity,
        base ? base.snapshotCapturedAt.getTime() + maximumQuoteAgeMs : Infinity,
        ...materialEconomies.map(
          (s) => Date.parse(s.verifiedAt ?? s.capturedAt) + maximumQuoteAgeMs,
        ),
        currencyExchange
          ? Date.parse(
              currencyExchange.verifiedAt ?? currencyExchange.capturedAt,
            ) + maximumQuoteAgeMs
          : Infinity,
        context.now.getTime() + maximumQuoteAgeMs,
      ),
    ).toISOString(),
    source: output
      ? {
          capturedAt: output.snapshotCapturedAt.toISOString(),
          sampleSize: output.aggregation.sampleSize,
          priceBasis: 'asking',
          coverage: output.coverage,
          sortedPageComplete: output.sortedPageComplete,
        }
      : null,
    marketStatus: output
      ? output.coverage !== 'complete'
        ? 'partial'
        : output.aggregation.sampleSize
          ? 'priced'
          : 'empty'
      : 'unavailable',
    materialEvidence,
    baseCost: basePrice,
    expectedBases: evidenceValid
      ? (definition.craft.baseConsumption?.expectedBases ?? null)
      : null,
    currencyExchange: conversionEvidence[0] ?? null,
    expectedCost:
      expectedCraftCost === null
        ? null
        : { amount: expectedCraftCost, currency },
  };
  const observations = output
    ? await context.repositories.observations.listRecent(
        output.marketQueryId,
        context.leagueId,
        new Date(0),
      )
    : [];
  const observation = observations.find(
    ({ observedAt }) =>
      observedAt.getTime() === output?.snapshotCapturedAt.getTime(),
  );
  return {
    confidence:
      output?.coverage === 'complete'
        ? confidence(output.aggregation.sampleSize)
        : 'low',
    currency,
    estimatedSalePrice: salePrice,
    expectedCraftCost,
    marginPercent: comparison.marginPercent,
    observationId: observation?.id ?? null,
    profit: comparison.profit,
    sourceSnapshotDedupeKey: output?.snapshotDedupeKey ?? null,
    status:
      salePrice === null || expectedCraftCost === null ? 'partial' : 'success',
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
  },
  requiredStock?: number,
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
  if (snapshot.expiresAt <= context.now) {
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
  listings = comparableRecipeListings(
    tradeQuery.query,
    listings,
    snapshot.capturedAt,
    context.now,
  );
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
      !payload.data.sortedPageComplete
        ? []
        : listings,
    totalListings: payload.data.totalResults,
  });
  return {
    aggregation,
    topOfBook,
    coverage: payload.data.coverage ?? 'unknown',
    sortedPageComplete: payload.data.sortedPageComplete ?? false,
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

function confidence(sampleSize: number) {
  return sampleSize >= 10 ? 'high' : sampleSize >= 3 ? 'medium' : 'low';
}

function toDomainError(cause: unknown): DomainError<DomainErrorCode> {
  return cause instanceof DomainError
    ? cause
    : new DomainError('CALCULATION_FAILED', { cause });
}
