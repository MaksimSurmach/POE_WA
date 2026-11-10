import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  GameDataCatalog,
  JsonRecord,
  Recipe,
  RecipeRepository,
} from '@poe-worksmith/domain';
import {
  clusterJewelVariantFilter,
  hashMarketQuery,
  mappedTargetFilter,
  noVariantFilter,
  recipeDocumentMetadata,
  RegisteredTradeQueryGenerator,
  validateRecipeDocument,
} from '@poe-worksmith/domain';
import { CronExpressionParser } from 'cron-parser';
import { and, eq, notInArray, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

import {
  generateRecipeMarketQuery,
  type RecipeMarketQuery,
} from '../recipeMarket.js';
import { createPostgresRepositories } from '../repositories/index.js';
import { discoverySchedules } from '../marketDiscovery.js';
import type { RuntimeConfig } from '../runtimeConfig.js';
import { collectorSchedule, poeLeagues, recipes } from '../schema.js';
import { createPostgresTradeMappingCatalog } from '../tradeMappings.js';
import { type LoadedRecipe, loadRecipeCatalog } from './loader.js';

export type RecipeSyncFailure = {
  id: string;
  message: string;
  operation: 'create' | 'disable' | 'hash' | 'update';
};

export type RecipeSyncReport = {
  created: string[];
  disabled: string[];
  failed: RecipeSyncFailure[];
  unchanged: string[];
  updated: string[];
};

export type ReadRecipeAsset = (assetPath: string) => Promise<Uint8Array>;

export type RecipeSyncOptions = {
  dryRun?: boolean;
  gameData?: GameDataCatalog | null;
};

export async function computeRecipeContentHash(
  recipe: LoadedRecipe,
  readAsset: ReadRecipeAsset,
) {
  const assets = [];
  for (const assetPath of [...recipe.assets].sort()) {
    const bytes = await readAsset(assetPath);
    assets.push({ path: assetPath, sha256: sha256(bytes) });
  }

  return sha256(
    JSON.stringify(
      canonicalize({
        assets,
        definition: recipe.definition,
        markdown: recipe.markdown,
        syncFormat: 1,
      }),
    ),
  );
}

export async function synchronizeRecipes(
  repository: RecipeRepository,
  sourceRecipes: readonly LoadedRecipe[],
  readAsset: ReadRecipeAsset,
  options: RecipeSyncOptions = {},
): Promise<RecipeSyncReport> {
  const report: RecipeSyncReport = {
    created: [],
    disabled: [],
    failed: [],
    unchanged: [],
    updated: [],
  };
  const existing = new Map(
    (await repository.listAll()).map((recipe) => [recipe.id, recipe]),
  );
  const sourceIds = new Set(
    sourceRecipes.map(({ definition }) => definition.id),
  );

  for (const source of [...sourceRecipes].sort((left, right) =>
    left.definition.id.localeCompare(right.definition.id),
  )) {
    const id = source.definition.id;
    const current = existing.get(id);
    let contentHash: string;
    try {
      contentHash = await computeRecipeContentHash(source, readAsset);
    } catch (error) {
      report.failed.push({
        id,
        message: errorMessage(error),
        operation: 'hash',
      });
      continue;
    }

    if (current?.active && current.contentHash === contentHash) {
      report.unchanged.push(id);
      continue;
    }

    const operation = current ? 'update' : 'create';
    try {
      if (!options.dryRun) {
        await repository.save(toRecipe(source, contentHash));
      }
      report[operation === 'create' ? 'created' : 'updated'].push(id);
    } catch (error) {
      report.failed.push({ id, message: errorMessage(error), operation });
    }
  }

  for (const current of [...existing.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (!current.active || sourceIds.has(current.id)) continue;
    try {
      if (!options.dryRun) {
        await repository.save({ ...current, active: false });
      }
      report.disabled.push(current.id);
    } catch (error) {
      report.failed.push({
        id: current.id,
        message: errorMessage(error),
        operation: 'disable',
      });
    }
  }

  return report;
}

export async function synchronizeRecipeCatalog(
  catalogPath: string,
  repository: RecipeRepository,
  options: RecipeSyncOptions = {},
) {
  const catalogRoot = path.resolve(catalogPath);
  const recipes = await loadRecipeCatalog(catalogRoot, options.gameData);
  return synchronizeRecipes(
    repository,
    recipes,
    (assetPath) => readFile(path.resolve(catalogRoot, assetPath)),
    options,
  );
}

export async function synchronizeCollectorSchedules(
  pool: Pool,
  config: Pick<
    RuntimeConfig,
    | 'cleanupCron'
    | 'collectorRetentionEnabled'
    | 'leagueResolveCron'
    | 'leagueResolveTimezone'
  >,
  now = new Date(),
  collectorClient?: PoolClient,
): Promise<
  'synchronized' | 'league-unavailable' | 'mapping-unavailable' | 'stale-input'
> {
  const repositories = createPostgresRepositories(pool);
  const league = await repositories.leagues.findCurrent();
  if (!league) return 'league-unavailable';
  const activeRecipes = await repositories.recipes.listActive();
  const trade = new RegisteredTradeQueryGenerator(
    createPostgresTradeMappingCatalog(pool),
    [noVariantFilter, clusterJewelVariantFilter],
    [mappedTargetFilter],
  );
  const targets = new Map<
    string,
    {
      query: RecipeMarketQuery;
      recipeIds: Set<string>;
      intervalMinutes: number;
    }
  >();
  for (const recipe of activeRecipes) {
    const definition = validateRecipeDocument(recipe.definition);
    for (const starting of [true, false]) {
      let query: RecipeMarketQuery;
      try {
        query = await generateRecipeMarketQuery(
          trade,
          definition,
          league.gggId,
          starting,
        );
      } catch (error) {
        // An incomplete catalog must not disable existing collection targets.
        if (
          error instanceof Error &&
          error.message
            .split(',')
            .every((code) => code === 'TRADE_MAPPING_MISSING')
        ) {
          return 'mapping-unavailable';
        }
        throw error;
      }
      const key = await hashMarketQuery({ ...query, league: league.gggId });
      const intervalMinutes = starting ? 120 : 60;
      const target = targets.get(key);
      if (target) {
        target.recipeIds.add(recipe.id);
        target.intervalMinutes = Math.min(
          target.intervalMinutes,
          intervalMinutes,
        );
      } else {
        targets.set(key, {
          query,
          recipeIds: new Set([recipe.id]),
          intervalMinutes,
        });
      }
    }
  }

  const rows: (typeof collectorSchedule.$inferInsert)[] = [
    ...Array.from(
      targets,
      ([key, { query, recipeIds, intervalMinutes }], index) => ({
        kind: 'trade-target',
        key,
        leagueId: league.id,
        payload: { ...query, recipeIds: [...recipeIds].sort() },
        intervalMinutes,
        nextDueAt: new Date(now.getTime() + index * 60_000),
      }),
    ),
    ...(await discoverySchedules(league, now)),
    {
      kind: 'economy',
      key: league.gggId,
      leagueId: league.id,
      payload: { league: league.gggId },
      intervalMinutes: 30,
      nextDueAt: now,
    },
    cronSchedule(
      'league',
      config.leagueResolveCron,
      config.leagueResolveTimezone,
      now,
    ),
    {
      ...cronSchedule('retention', config.cleanupCron, 'UTC', now),
      enabled: config.collectorRetentionEnabled,
    },
  ];
  const recipeHashes = new Map(
    activeRecipes.map(({ id, contentHash }) => [id, contentHash]),
  );
  const db = drizzle({ client: collectorClient ?? pool });
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext('poe-worksmith:collector-schedule-sync'))`,
    );
    const [currentLeague] = await transaction
      .select({ id: poeLeagues.id })
      .from(poeLeagues)
      .where(eq(poeLeagues.isCurrent, true))
      .limit(1);
    if (currentLeague?.id !== league.id) return 'stale-input';
    const currentRecipes = await transaction
      .select({ id: recipes.id, contentHash: recipes.contentHash })
      .from(recipes)
      .where(eq(recipes.active, true));
    if (
      currentRecipes.length !== recipeHashes.size ||
      currentRecipes.some(
        ({ id, contentHash }) => recipeHashes.get(id) !== contentHash,
      )
    ) {
      return 'stale-input';
    }
    await transaction
      .insert(collectorSchedule)
      .values(rows)
      .onConflictDoUpdate({
        target: [collectorSchedule.kind, collectorSchedule.key],
        set: {
          enabled: sql`excluded.enabled`,
          leagueId: sql`excluded.league_id`,
          payload: sql`excluded.payload`,
          intervalMinutes: sql`excluded.interval_minutes`,
          nextDueAt: sql`case
            when excluded.kind in ('league', 'retention')
              and ${collectorSchedule.payload} is distinct from excluded.payload
              and (${collectorSchedule.leasedUntil} is null or ${collectorSchedule.leasedUntil} <= ${now.toISOString()}::timestamptz)
            then excluded.next_due_at
            else ${collectorSchedule.nextDueAt}
          end`,
        },
      });
    await transaction
      .update(collectorSchedule)
      .set({ enabled: false })
      .where(
        and(
          eq(collectorSchedule.enabled, true),
          or(
            ...['trade-target', 'economy', 'league', 'retention'].map((kind) =>
              and(
                eq(collectorSchedule.kind, kind),
                notInArray(
                  collectorSchedule.key,
                  rows.filter((row) => row.kind === kind).map(({ key }) => key),
                ),
              ),
            ),
          ),
        ),
      );
    return 'synchronized';
  });
}

function cronSchedule(
  kind: 'league' | 'retention',
  cron: string,
  timezone: string,
  now: Date,
) {
  const schedule = CronExpressionParser.parse(cron, {
    currentDate: now,
    tz: timezone,
  });
  const nextDueAt = schedule.next().toDate();
  return {
    kind,
    key: kind,
    payload: { cron, timezone },
    intervalMinutes: Math.ceil(
      (schedule.next().getTime() - nextDueAt.getTime()) / 60_000,
    ),
    nextDueAt,
  };
}

function toRecipe(source: LoadedRecipe, contentHash: string): Recipe {
  const metadata = recipeDocumentMetadata(source.definition);
  return {
    active: true,
    category: metadata.category,
    contentHash,
    craftMethod: metadata.craftMethod,
    definition: { ...source.definition } as JsonRecord,
    gameVersion: metadata.gameVersion,
    guideMarkdown: source.markdown,
    id: metadata.id,
    tags: metadata.tags,
    title: metadata.title,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Unknown synchronization error';
}
