import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { marketAdminSettingsSchema } from '@poe-worksmith/contracts';
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
import {
  preloadScrapedItemSpecs,
  readScrapedItemFingerprint,
  scrapedItemFingerprintSql,
  scrapedItemLockSql,
  seedScrapedItems,
} from '../repositories/scrapedItemRepository.js';
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
  tradePoolMinutes?: Record<string, number> | undefined;
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
  const periods = marketAdminSettingsSchema.shape.tradePoolMinutes.parse(
    options.tradePoolMinutes,
  );
  for (const { definition } of sourceRecipes) {
    for (const [role, priority] of [
      ['base', definition.scrapingPriority?.base ?? 2],
      ['output', definition.scrapingPriority?.output ?? 1],
    ] as const) {
      if (!Object.hasOwn(periods, priority))
        throw new Error(
          `Recipe ${definition.id} requires a period for Trade pool ${priority} (${role})`,
        );
    }
  }
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

export async function synchronizeStoredRecipeCatalog(
  catalogPath: string,
  pool: Pool,
  options: RecipeSyncOptions,
  collectorClient?: PoolClient,
) {
  const catalogRoot = path.resolve(catalogPath);
  const catalog = await loadRecipeCatalog(catalogRoot, options.gameData);
  const client = collectorClient ?? (await pool.connect());
  try {
    await client.query(
      "select pg_advisory_lock(hashtext('poe-worksmith:collector-schedule-sync'))",
    );
    try {
      const { rows } = await client.query<{
        periods: Record<string, number> | null;
      }>(
        "select settings->'tradePoolMinutes' as periods from market_admin_settings where id = 1",
      );
      return await synchronizeRecipes(
        createPostgresRepositories(pool, client).recipes,
        catalog,
        (assetPath) => readFile(path.resolve(catalogRoot, assetPath)),
        { ...options, tradePoolMinutes: rows[0]?.periods ?? undefined },
      );
    } finally {
      await client.query(
        "select pg_advisory_unlock(hashtext('poe-worksmith:collector-schedule-sync'))",
      );
    }
  } finally {
    if (!collectorClient) client.release();
  }
}

type ScheduleSyncResult =
  'synchronized' | 'league-unavailable' | 'mapping-unavailable' | 'stale-input';
type ScheduleConfig = Pick<
  RuntimeConfig,
  | 'cleanupCron'
  | 'collectorRetentionEnabled'
  | 'leagueResolveCron'
  | 'leagueResolveTimezone'
>;

export function synchronizeCollectorSchedules(
  pool: Pool,
  config: ScheduleConfig,
  now = new Date(),
  collectorClient?: PoolClient,
): Promise<ScheduleSyncResult> {
  return synchronizeSchedules(pool, config, now, collectorClient);
}

/**
 * Applies recipe and configured scraped-item changes to the trade searches only.
 * Leaves league, economy and retention schedules to the collector, whose
 * environment (for example retention) the API process cannot be assumed to share.
 */
export async function synchronizeTradeTargetSchedules(
  pool: Pool,
  now = new Date(),
): Promise<ScheduleSyncResult> {
  // A collector that never bootstrapped must still create its own schedules first.
  const { rows } = await pool.query<{ ready: boolean }>(
    "select exists(select 1 from collector_schedule where kind = 'league') as ready",
  );
  return rows[0]?.ready
    ? synchronizeSchedules(pool, null, now)
    : 'league-unavailable';
}

async function synchronizeSchedules(
  pool: Pool,
  config: ScheduleConfig | null,
  now: Date,
  collectorClient?: PoolClient,
): Promise<ScheduleSyncResult> {
  const repositories = createPostgresRepositories(pool);
  const league = await repositories.leagues.findCurrent();
  if (!league) return 'league-unavailable';
  const activeRecipes = await repositories.recipes.listActive();
  const definitions = new Map(
    activeRecipes.map((recipe) => [
      recipe.id,
      validateRecipeDocument(recipe.definition),
    ]),
  );
  // Existing links are never rewritten here, so a sync cannot undo an owner edit.
  await seedScrapedItems(
    pool,
    [...definitions].map(([id, definition]) => ({ id, definition })),
  );
  const configFingerprint = await readScrapedItemFingerprint(pool);
  const specs = await preloadScrapedItemSpecs(pool, [...definitions.keys()]);
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
      outputRecipeIds: Set<string>;
      scrapingPriority: number;
      items: Map<string, { id: string; revision: number; role: string }>;
    }
  >();
  for (const recipe of activeRecipes) {
    const definition = definitions.get(recipe.id)!;
    for (const starting of [true, false]) {
      let query: RecipeMarketQuery;
      try {
        query = await generateRecipeMarketQuery(
          trade,
          definition,
          league.gggId,
          starting,
          specs,
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
      const scrapingPriority = starting
        ? (definition.scrapingPriority?.base ?? 2)
        : (definition.scrapingPriority?.output ?? 1);
      const configured = (await specs(definition))[starting ? 'base' : 'output']
        .configured;
      const target = targets.get(key);
      if (target) {
        if (configured)
          target.items.set(configured.id, {
            ...configured,
            role: starting ? 'base' : 'output',
          });
        target.recipeIds.add(recipe.id);
        if (!starting) target.outputRecipeIds.add(recipe.id);
        target.scrapingPriority = Math.min(
          target.scrapingPriority,
          scrapingPriority,
        );
      } else {
        targets.set(key, {
          query,
          recipeIds: new Set([recipe.id]),
          outputRecipeIds: new Set(starting ? [] : [recipe.id]),
          scrapingPriority,
          items: new Map(
            configured
              ? [
                  [
                    configured.id,
                    { ...configured, role: starting ? 'base' : 'output' },
                  ],
                ]
              : [],
          ),
        });
      }
    }
  }

  const rows: (typeof collectorSchedule.$inferInsert)[] = [
    ...Array.from(
      targets,
      ([
        key,
        { query, recipeIds, outputRecipeIds, items, scrapingPriority },
      ]) => ({
        kind: 'trade-target',
        key,
        leagueId: league.id,
        payload: {
          ...query,
          recipeIds: [...recipeIds].sort(),
          outputRecipeIds: [...outputRecipeIds].sort(),
          scrapedItems: [...items.values()].sort((a, b) =>
            a.id.localeCompare(b.id),
          ),
        },
        scrapingPriority,
        // Pool reconciliation assigns the actual interval before commit.
        intervalMinutes: 1,
        nextDueAt: now,
      }),
    ),
    ...(await discoverySchedules(league, now)),
    ...(config
      ? [
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
        ]
      : []),
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
    // Hold edits off until this synchronization commits, then confirm none landed first.
    await transaction.execute(sql.raw(scrapedItemLockSql));
    const [{ fingerprint }] = (
      await transaction.execute<{ fingerprint: string }>(
        sql.raw(scrapedItemFingerprintSql),
      )
    ).rows as [{ fingerprint: string }];
    if (fingerprint !== configFingerprint) return 'stale-input';
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
          scrapingPriority: sql`excluded.scraping_priority`,
          intervalMinutes: sql`case when excluded.scraping_priority is null
            then excluded.interval_minutes else ${collectorSchedule.intervalMinutes} end`,
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
            ...(config
              ? ['trade-target', 'economy', 'league', 'retention']
              : ['trade-target']
            ).map((kind) =>
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
    await transaction.execute(
      sql`select reconcile_trade_pools(${now.toISOString()}::timestamptz)`,
    );
    await transaction.execute(sql`select pg_notify('worksmith_wake', '')`);
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
