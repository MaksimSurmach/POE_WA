import {
  aggregateMarketListings,
  type CanonicalJsonObject,
  type CanonicalJsonValue,
  type CanonicalRecipeV1,
  DomainError,
  type DomainErrorCode,
  type MarketListing,
  type NewRecipeEvaluation,
  type Recipe,
  type RecipeEvaluation,
  type Repositories,
  hashMarketQuery,
  transitionRefreshCycle,
  validateRecipeV1,
} from '@poe-worksmith/domain';
import { calculateRecipeEconomics } from '@poe-worksmith/domain/economics';
import { z } from 'zod';

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
  listings: z.array(listingSchema),
  totalResults: z.number().int().nonnegative(),
});

type FreshEvaluation = Readonly<{
  confidence: 'low' | 'medium' | 'high';
  currency: string;
  estimatedSalePrice: string;
  expectedCraftCost: string;
  marginPercent: string;
  observationId: number | null;
  profit: string;
  sourceSnapshotDedupeKey: string;
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

  const recipes = (await repositories.recipes.listActive()).sort(
    (left, right) => left.id.localeCompare(right.id),
  );
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
  const evaluateRecipe = options.evaluateRecipe ?? evaluateFreshRecipe;
  const evaluations: RecipeEvaluation[] = [];
  let completedRecipes = 0;
  let failedRecipes = 0;
  let staleFallbacks = 0;

  for (const recipe of recipes) {
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
        lastSuccessfulAt: now,
        leagueId: cycle.leagueId,
        recipeId: recipe.id,
        refreshCycleId: cycle.id,
        status: 'success',
      };
      completedRecipes += 1;
    } catch (cause) {
      const error = toDomainError(cause);
      const fallback = previousByRecipe.get(recipe.id);
      evaluation = reusableEvaluation(fallback)
        ? {
            confidence: fallback.confidence,
            currency: fallback.currency,
            errorCode: error.code,
            estimatedSalePrice: fallback.estimatedSalePrice,
            evaluatedAt: now,
            expectedCraftCost: fallback.expectedCraftCost,
            lastSuccessfulAt: fallback.lastSuccessfulAt ?? fallback.evaluatedAt,
            leagueId: cycle.leagueId,
            marginPercent: fallback.marginPercent,
            observationId: fallback.observationId,
            profit: fallback.profit,
            recipeId: recipe.id,
            refreshCycleId: cycle.id,
            sourceSnapshotDedupeKey: fallback.sourceSnapshotDedupeKey,
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
            status: 'error',
          };
      failedRecipes += 1;
      if (evaluation.status === 'stale') staleFallbacks += 1;
    }
    evaluations.push(await repositories.evaluations.save(evaluation));
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
    const published = await repositories.cycles.publish(cycle.id, now);
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
): Promise<FreshEvaluation> {
  let definition: CanonicalRecipeV1;
  try {
    definition = validateRecipeV1(recipe.definition);
  } catch (cause) {
    throw new DomainError('RECIPE_INVALID', { cause });
  }
  const base = await resolveMarket(
    definition.baseRequirements.tradeQuery,
    context,
  );
  const materials = await Promise.all(
    definition.materials.map(
      async (material) =>
        [
          material.id,
          (await resolveMarket(material.tradeQuery, context)).aggregation
            .cheapest,
        ] as const,
    ),
  );
  const finishing = await Promise.all(
    definition.finishingCosts.map(
      async (cost) =>
        [
          cost.id,
          (await resolveMarket(cost.tradeQuery, context)).aggregation.cheapest,
        ] as const,
    ),
  );
  const output = await resolveMarket(definition.output.tradeQuery, context);
  const result = calculateRecipeEconomics({
    aggregation: output.aggregation,
    basePrice: base.aggregation.cheapest,
    currency: output.aggregation.currency,
    finishingPrices: Object.fromEntries(finishing),
    materialPrices: Object.fromEntries(materials),
    recipe: definition,
  });
  if (!result.ok) throw new DomainError(result.errorCode);

  const observations = await context.repositories.observations.listRecent(
    output.marketQueryId,
    context.leagueId,
    new Date(0),
  );
  const observation = observations.find(
    ({ observedAt }) =>
      observedAt.getTime() === output.snapshotCapturedAt.getTime(),
  );
  return {
    confidence: confidence(output.aggregation.sampleSize),
    currency: result.value.profit.currency,
    estimatedSalePrice: result.value.estimatedSalePrice.amount,
    expectedCraftCost: result.value.breakdown.expectedCraftCost.amount,
    marginPercent: result.value.marginPercent,
    observationId: observation?.id ?? null,
    profit: result.value.profit.amount,
    sourceSnapshotDedupeKey: output.snapshotDedupeKey,
  };
}

async function resolveMarket(
  tradeQuery: CanonicalRecipeV1['baseRequirements']['tradeQuery'],
  context: {
    leagueId: string;
    league: string;
    now: Date;
    repositories: Repositories;
  },
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
  const listings: MarketListing[] = payload.data.listings.map((listing) => ({
    ...listing,
    indexedAt: new Date(listing.indexedAt),
  }));
  const currency = listings[0]?.price.currency ?? 'unknown';
  const aggregation = aggregateMarketListings({
    currency,
    listings,
    totalListings: payload.data.totalResults,
  });
  return {
    aggregation,
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
  expectedCraftCost: string;
  marginPercent: string;
  profit: string;
} {
  return Boolean(
    evaluation?.currency &&
    evaluation.estimatedSalePrice &&
    evaluation.expectedCraftCost &&
    evaluation.marginPercent &&
    evaluation.profit &&
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
