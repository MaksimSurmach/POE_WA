import { randomUUID } from 'node:crypto';
import {
  storedMarketAdminSettingsSchema,
  marketCollectionRunSchema,
} from '@poe-worksmith/contracts';
import {
  clusterJewelVariantFilter,
  DomainError,
  hashMarketQuery,
  mappedTargetFilter,
  noVariantFilter,
  recipeSchema,
  RegisteredTradeQueryGenerator,
  transitionRefreshCycle,
} from '@poe-worksmith/domain';
import pino from 'pino';

import { evaluateAndPublishCatalog } from '../catalogPublisher.js';
import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { collectionRunBatch } from '../marketCollectionSource.js';
import { trySavedTradePublicationLock } from '../marketAdmin.js';
import { marketSearchPayload } from '../marketJobProcessor.js';
import { collectionSearchResult } from '../providers/poeTrade.js';
import {
  createRecipeMarketDependencies,
  recipeQueryTarget,
  type RecipeMarketQuery,
} from '../recipeMarket.js';
import { createPostgresRepositories } from '../repositories/index.js';
import { createMarketEconomyRepository } from '../repositories/marketEconomyRepository.js';
import { createPostgresTradeMappingCatalog } from '../tradeMappings.js';
import { RetentionCleaner } from '../retention.js';

const logger = pino();
const pool = createDatabasePool(loadDatabaseConfig());

try {
  const lock = await pool.connect();
  try {
    await lock.query('begin');
    if (await trySavedTradePublicationLock(lock)) {
      const active = await lock.query(
        "select 1 from market_admin_runs where status='running' limit 1",
      );
      if (!active.rowCount) await publish();
    }
    await lock.query('commit');
  } finally {
    lock.release(true);
  }
} catch (error) {
  logger.error(
    {
      code:
        error instanceof DomainError
          ? error.code
          : error instanceof Error
            ? error.name
            : 'UNKNOWN',
    },
    'saved_trade.publish.failed',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}

async function publish() {
  const repositories = createPostgresRepositories(pool);
  const settings = await pool.query<{ settings: unknown }>(
    'select settings from market_admin_settings where id=1',
  );
  const {
    collectionsPaused,
    freshnessWarningMs,
    maximumQuoteAgeMs,
    rawRetentionHours,
    historyRetentionDays,
  } = storedMarketAdminSettingsSchema.parse(settings.rows[0]?.settings);
  if (collectionsPaused) return;
  const league = await repositories.leagues.findCurrent();
  if (!league) throw new Error('CURRENT_LEAGUE_UNRESOLVED');
  const recipes = await repositories.recipes.listActive();
  const marketDependencies = createRecipeMarketDependencies({
    trade: new RegisteredTradeQueryGenerator(
      createPostgresTradeMappingCatalog(pool),
      [noVariantFilter, clusterJewelVariantFilter],
      [mappedTargetFilter],
    ),
    resolveResource: async () => null,
  });
  const now = new Date();
  const oldest = new Date(now.getTime() - maximumQuoteAgeMs);
  const queries = new Map<
    string,
    {
      recipeId: string;
      query: RecipeMarketQuery;
      target: ReturnType<typeof recipeQueryTarget>;
    }
  >();
  for (const recipe of recipes) {
    for (const { query } of await marketDependencies({
      league: league.gggId,
      recipe: recipeSchema.parse(recipe.definition),
    })) {
      if (!query) continue;
      const hash = await hashMarketQuery({ league: league.gggId, ...query });
      queries.set(hash, {
        recipeId: recipe.id,
        query,
        target: recipeQueryTarget(query.query.handbookTarget),
      });
    }
  }

  let cycle = await repositories.cycles.save({
    id: randomUUID(),
    leagueId: league.id,
    requestedAt: now,
    startedAt: null,
    finishedAt: null,
    publishedAt: null,
    errorMessage: null,
    status: 'queued',
    totalRecipes: recipes.length,
    completedRecipes: 0,
    failedRecipes: 0,
    totalQueries: 0,
    completedQueries: 0,
    failedQueries: 0,
  });
  try {
    let observed = 0;
    let imported = 0;
    for (const [hash, { query, target, recipeId }] of queries) {
      const result = await pool.query<{ payload: unknown }>(
        `select r.payload from market_targets t join market_collection_runs r on r.target_id=t.id
         where t.digest=$1 and r.target_digest=t.digest and r.league=$2 and r.patch=$3
           and r.trigger='scheduled' and r.status in ('succeeded','partial','empty')
           and r.started_at<=$4 and r.completed_at>=$5
           and r.payload @> '{"sourceId":"trade-compatible","dataKind":"observed","cached":false,"cancelRequested":false}'
           and r.payload->>'errorCode' is null and r.payload->>'rawAvailable' is distinct from 'false'
         order by r.started_at desc, r.id desc limit 1`,
        [target.digest, target.league, target.patch, now, oldest],
      );
      if (!result.rows[0]) continue;
      const run = marketCollectionRunSchema.parse(result.rows[0].payload);
      let market;
      try {
        market = collectionSearchResult(
          collectionRunBatch(run),
          query.query,
          target,
        );
      } catch (error) {
        if (
          !(error instanceof DomainError) ||
          error.code !== 'MARKET_COLLECTION_FAILED'
        )
          throw error;
        logger.warn(
          { targetId: run.targetId, runId: run.id, code: error.code },
          'saved_trade.query.unusable',
        );
        continue;
      }
      if (market.fetchedAt <= oldest || market.fetchedAt > now) continue;
      const marketQuery =
        (await repositories.marketQueries.findByCanonicalHash(hash)) ??
        (await repositories.marketQueries.save({
          id: randomUUID(),
          active: true,
          canonicalHash: hash,
          provider: query.provider,
          query: query.query,
          recipeId,
        }));
      const saved = await repositories.snapshots.save({
        capturedAt: market.fetchedAt,
        dedupeKey: `scheduled-trade:${run.snapshotId ?? run.id}:${hash}`,
        expiresAt: new Date(market.fetchedAt.getTime() + maximumQuoteAgeMs),
        leagueId: league.id,
        marketQueryId: marketQuery.id,
        refreshCycleId: cycle.id,
        payload: marketSearchPayload(market),
        providerStatus: 200,
      });
      observed++;
      if (saved.inserted) imported++;
    }
    const report = await evaluateAndPublishCatalog(repositories, {
      allowMissingOutput: true,
      cycleId: cycle.id,
      league: league.gggId,
      leagueName: league.name,
      now,
      maximumQuoteAgeMs,
      freshnessWarningMs,
      marketDependencies,
      economy: createMarketEconomyRepository(pool),
      logger,
    });
    logger.info(
      {
        cycleId: cycle.id,
        queries: queries.size,
        observed,
        imported,
        published: report.published,
        evaluated: report.completedRecipes,
        failed: report.failedRecipes,
        asks: report.evaluations.filter(
          (entry) => entry.estimatedSalePrice !== null,
        ).length,
        craftCosts: report.evaluations.filter(
          (entry) => entry.expectedCraftCost !== null,
        ).length,
      },
      'saved_trade.publish.completed',
    );
    if (!report.published) {
      process.exitCode = 1;
      return;
    }
    await new RetentionCleaner({
      repositories,
      maxBatches: 1,
      rawSnapshotsRetentionMs: rawRetentionHours * 3_600_000,
      observationsRetentionMs: historyRetentionDays * 86_400_000,
    }).run();
  } catch (error) {
    cycle = (await repositories.cycles.findById(cycle.id)) ?? cycle;
    if (cycle.status === 'queued' || cycle.status === 'running')
      await repositories.cycles.save(
        transitionRefreshCycle(
          cycle,
          'failed',
          new Date(),
          'Saved Trade publication failed.',
        ),
      );
    throw error;
  }
}
