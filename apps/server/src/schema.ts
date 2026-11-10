import type { RecipeResult } from './recipeResult.js';
import type { RateLimitWindow } from '@poe-worksmith/domain';
import type { MarketAdminSettings } from '@poe-worksmith/contracts';
import type {
  MarketTarget,
  MarketResearchSnapshotSummary,
  MarketImportListing,
  MarketEconomySummary,
  MarketCollectionSettings,
  MarketCollectionRun,
  BeltPriceUpdate,
} from '@poe-worksmith/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const marketAdminSettings = pgTable(
  'market_admin_settings',
  {
    id: integer('id').primaryKey().default(1),
    version: integer('version').notNull().default(0),
    settings: jsonb('settings').$type<MarketAdminSettings>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [check('market_admin_settings_singleton', sql`${t.id} = 1`)],
);

export const marketAdminAudit = pgTable('market_admin_audit', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull(),
});

export const marketAdminRuns = pgTable(
  'market_admin_runs',
  {
    id: uuid('id').primaryKey(),
    scope: text('scope').notNull(),
    recipeId: text('recipe_id'),
    source: text('source').notNull(),
    status: text('status').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    errorCode: text('error_code'),
    progress: jsonb('progress')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    uniqueIndex('market_admin_runs_single_active')
      .on(sql`(1)`)
      .where(sql`${t.status} in ('queued', 'running')`),
    index('market_admin_runs_requested_idx').on(t.requestedAt),
    check(
      'market_admin_runs_status_check',
      sql`${t.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped')`,
    ),
    check(
      'market_admin_runs_scope_check',
      sql`${t.scope} in ('all', 'economy', 'recipe')`,
    ),
  ],
);

export const marketWorkerHealth = pgTable('market_worker_health', {
  id: text('id').primaryKey(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull(),
  settingsVersion: integer('settings_version').notNull(),
});

export const refreshCycles = pgTable(
  'refresh_cycles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    leagueId: uuid('league_id')
      .notNull()
      .references(() => poeLeagues.id, { onDelete: 'restrict' }),
    status: text('status').default('queued').notNull(),
    totalRecipes: integer('total_recipes').default(0).notNull(),
    totalQueries: integer('total_queries').default(0).notNull(),
    completedQueries: integer('completed_queries').default(0).notNull(),
    completedRecipes: integer('completed_recipes').default(0).notNull(),
    failedQueries: integer('failed_queries').default(0).notNull(),
    failedRecipes: integer('failed_recipes').default(0).notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    ...timestamps,
  },
  (table) => [
    check(
      'refresh_cycles_status_check',
      sql`${table.status} in ('queued', 'running', 'completed', 'published', 'failed', 'superseded')`,
    ),
    check(
      'refresh_cycles_counts_check',
      sql`${table.totalRecipes} >= 0 and ${table.totalQueries} >= 0 and ${table.completedQueries} >= 0 and ${table.completedRecipes} >= 0 and ${table.failedQueries} >= 0 and ${table.failedRecipes} >= 0 and ${table.completedQueries} + ${table.failedQueries} <= ${table.totalQueries} and ${table.completedRecipes} + ${table.failedRecipes} <= ${table.totalRecipes}`,
    ),
    index('refresh_cycles_status_requested_at_idx').on(
      table.status,
      table.requestedAt,
    ),
    index('refresh_cycles_requested_at_idx').on(table.requestedAt),
    uniqueIndex('refresh_cycles_single_running_uq')
      .on(table.status)
      .where(sql`${table.status} = 'running'`),
    index('refresh_cycles_published_at_idx')
      .on(table.publishedAt)
      .where(sql`${table.publishedAt} is not null`),
  ],
);

export const poeLeagues = pgTable(
  'poe_leagues',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    game: text('game').default('poe1').notNull(),
    realm: text('realm').default('pc').notNull(),
    gggId: text('ggg_id').notNull(),
    name: text('name').notNull(),
    startAt: timestamp('start_at', { withTimezone: true }),
    endAt: timestamp('end_at', { withTimezone: true }),
    isCurrent: boolean('is_current').default(false).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('poe_leagues_game_realm_ggg_id_uq').on(
      table.game,
      table.realm,
      table.gggId,
    ),
    uniqueIndex('poe_leagues_one_current_uq')
      .on(table.game, table.realm)
      .where(sql`${table.isCurrent} = true`),
    check(
      'poe_leagues_dates_check',
      sql`${table.endAt} is null or ${table.startAt} is null or ${table.endAt} >= ${table.startAt}`,
    ),
  ],
);

export const recipes = pgTable(
  'recipes',
  {
    id: text('id').primaryKey(),
    contentHash: text('content_hash').notNull(),
    title: text('title').notNull(),
    category: text('category').notNull(),
    craftMethod: text('craft_method').notNull(),
    gameVersion: text('game_version').notNull(),
    tags: text('tags')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    guideMarkdown: text('guide_markdown').notNull(),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    active: boolean('active').default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('recipes_content_hash_uq').on(table.contentHash),
    index('recipes_active_category_updated_at_idx')
      .on(table.category, table.updatedAt)
      .where(sql`${table.active} = true`),
  ],
);

export const marketQueries = pgTable(
  'market_queries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    recipeId: text('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull(),
    canonicalHash: text('canonical_hash').notNull(),
    query: jsonb('query').$type<Record<string, unknown>>().notNull(),
    active: boolean('active').default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('market_queries_canonical_hash_uq').on(table.canonicalHash),
    index('market_queries_recipe_id_idx').on(table.recipeId),
    index('market_queries_active_provider_idx')
      .on(table.provider, table.updatedAt)
      .where(sql`${table.active} = true`),
  ],
);

export const rawSnapshots = pgTable(
  'raw_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    dedupeKey: text('dedupe_key').notNull(),
    marketQueryId: uuid('market_query_id')
      .notNull()
      .references(() => marketQueries.id, { onDelete: 'cascade' }),
    leagueId: uuid('league_id')
      .notNull()
      .references(() => poeLeagues.id, { onDelete: 'restrict' }),
    refreshCycleId: uuid('refresh_cycle_id')
      .notNull()
      .references(() => refreshCycles.id, { onDelete: 'cascade' }),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    providerStatus: integer('provider_status').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('raw_snapshots_dedupe_key_uq').on(table.dedupeKey),
    index('raw_snapshots_market_query_captured_at_idx').on(
      table.marketQueryId,
      table.capturedAt,
    ),
    index('raw_snapshots_refresh_cycle_id_idx').on(table.refreshCycleId),
    index('raw_snapshots_expires_at_idx').on(table.expiresAt),
    check(
      'raw_snapshots_provider_status_check',
      sql`${table.providerStatus} between 100 and 599`,
    ),
  ],
);

export const aggregatedObservations = pgTable(
  'aggregated_observations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    marketQueryId: uuid('market_query_id')
      .notNull()
      .references(() => marketQueries.id, { onDelete: 'restrict' }),
    leagueId: uuid('league_id')
      .notNull()
      .references(() => poeLeagues.id, { onDelete: 'restrict' }),
    refreshCycleId: uuid('refresh_cycle_id')
      .notNull()
      .references(() => refreshCycles.id, { onDelete: 'cascade' }),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    sampleSize: integer('sample_size').notNull(),
    currency: text('currency').notNull(),
    cheapestPrice: numeric('cheapest_price', {
      precision: 20,
      scale: 8,
    }),
    nthPrice: numeric('nth_price', { precision: 20, scale: 8 }),
    medianTopNPrice: numeric('median_top_n_price', {
      precision: 20,
      scale: 8,
    }),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('aggregated_observations_query_cycle_uq').on(
      table.marketQueryId,
      table.refreshCycleId,
    ),
    index('aggregated_observations_query_observed_at_idx').on(
      table.marketQueryId,
      table.observedAt,
    ),
    index('aggregated_observations_refresh_cycle_id_idx').on(
      table.refreshCycleId,
    ),
    index('aggregated_observations_observed_at_idx').on(table.observedAt),
    check(
      'aggregated_observations_sample_size_check',
      sql`${table.sampleSize} >= 0`,
    ),
    check(
      'aggregated_observations_prices_check',
      sql`${table.cheapestPrice} >= 0 and (${table.nthPrice} is null or ${table.nthPrice} >= 0) and (${table.medianTopNPrice} is null or ${table.medianTopNPrice} >= 0)`,
    ),
  ],
);

export const recipeEvaluations = pgTable(
  'recipe_evaluations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    recipeId: text('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'restrict' }),
    leagueId: uuid('league_id')
      .notNull()
      .references(() => poeLeagues.id, { onDelete: 'restrict' }),
    refreshCycleId: uuid('refresh_cycle_id')
      .notNull()
      .references(() => refreshCycles.id, { onDelete: 'cascade' }),
    observationId: bigint('observation_id', { mode: 'number' }).references(
      () => aggregatedObservations.id,
      { onDelete: 'set null' },
    ),
    sourceSnapshotDedupeKey: text('source_snapshot_dedupe_key'),
    status: text('status').notNull(),
    currency: text('currency'),
    expectedCraftCost: numeric('expected_craft_cost', {
      precision: 20,
      scale: 8,
    }),
    estimatedSalePrice: numeric('estimated_sale_price', {
      precision: 20,
      scale: 8,
    }),
    profit: numeric('profit', { precision: 20, scale: 8 }),
    marginPercent: numeric('margin_percent', { precision: 12, scale: 6 }),
    confidence: text('confidence'),
    errorCode: text('error_code'),
    historicalMethodCosts: jsonb('variant_costs').$type<Record<
      string,
      unknown
    > | null>(),
    methodCost: jsonb('method_cost').$type<Record<string, unknown> | null>(),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
    lastSuccessfulAt: timestamp('last_successful_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('recipe_evaluations_recipe_cycle_uq').on(
      table.recipeId,
      table.refreshCycleId,
    ),
    index('recipe_evaluations_recipe_evaluated_at_idx').on(
      table.recipeId,
      table.evaluatedAt,
    ),
    index('recipe_evaluations_refresh_cycle_id_idx').on(table.refreshCycleId),
    index('recipe_evaluations_observation_id_idx').on(table.observationId),
    index('recipe_evaluations_status_evaluated_at_idx').on(
      table.status,
      table.evaluatedAt,
    ),
    check(
      'recipe_evaluations_status_check',
      sql`${table.status} in ('success', 'stale', 'partial', 'error')`,
    ),
    check(
      'recipe_evaluations_confidence_check',
      sql`${table.confidence} is null or ${table.confidence} in ('low', 'medium', 'high')`,
    ),
    check(
      'recipe_evaluations_prices_check',
      sql`(${table.expectedCraftCost} is null or ${table.expectedCraftCost} >= 0) and (${table.estimatedSalePrice} is null or ${table.estimatedSalePrice} >= 0)`,
    ),
  ],
);

export const catalogState = pgTable(
  'catalog_state',
  {
    id: integer('id').default(1).primaryKey(),
    publishedCycleId: uuid('published_cycle_id').references(
      () => refreshCycles.id,
      { onDelete: 'restrict' },
    ),
    previousCycleId: uuid('previous_cycle_id').references(
      () => refreshCycles.id,
      { onDelete: 'set null' },
    ),
    revision: bigint('revision', { mode: 'number' }).default(0).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    check('catalog_state_singleton_check', sql`${table.id} = 1`),
    index('catalog_state_published_cycle_id_idx').on(table.publishedCycleId),
    index('catalog_state_previous_cycle_id_idx').on(table.previousCycleId),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    dedupeKey: text('dedupe_key').notNull(),
    kind: text('kind').notNull(),
    status: text('status').default('queued').notNull(),
    priority: integer('priority').default(0).notNull(),
    attempts: integer('attempts').default(0).notNull(),
    maxAttempts: integer('max_attempts').default(3).notNull(),
    refreshCycleId: uuid('refresh_cycle_id').references(
      () => refreshCycles.id,
      { onDelete: 'cascade' },
    ),
    recipeId: text('recipe_id').references(() => recipes.id, {
      onDelete: 'restrict',
    }),
    marketQueryId: uuid('market_query_id').references(() => marketQueries.id, {
      onDelete: 'restrict',
    }),
    runAfter: timestamp('run_after', { withTimezone: true })
      .defaultNow()
      .notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('jobs_dedupe_key_uq').on(table.dedupeKey),
    index('jobs_pending_run_after_idx')
      .on(table.status, table.priority.desc(), table.runAfter)
      .where(sql`${table.status} in ('queued', 'retry')`),
    index('jobs_running_locked_at_idx')
      .on(table.lockedAt)
      .where(sql`${table.status} = 'running'`),
    index('jobs_refresh_cycle_id_idx').on(table.refreshCycleId),
    index('jobs_recipe_id_idx').on(table.recipeId),
    index('jobs_market_query_id_idx').on(table.marketQueryId),
    check(
      'jobs_kind_check',
      sql`${table.kind} in ('recipe_refresh', 'catalog_publish', 'snapshot_cleanup')`,
    ),
    check(
      'jobs_status_check',
      sql`${table.status} in ('queued', 'running', 'retry', 'succeeded', 'failed')`,
    ),
    check(
      'jobs_attempts_check',
      sql`${table.attempts} >= 0 and ${table.maxAttempts} > 0 and ${table.attempts} <= ${table.maxAttempts}`,
    ),
  ],
);

export const rateLimitStates = pgTable(
  'rate_limit_states',
  {
    policy: text('policy').primaryKey(),
    blockedUntil: timestamp('blocked_until', { withTimezone: true })
      .defaultNow()
      .notNull(),
    nextRequestAt: timestamp('next_request_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    minimumDelayMs: integer('minimum_delay_ms').default(1000).notNull(),
    windows: jsonb('windows')
      .$type<RateLimitWindow[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    lastStatus: integer('last_status'),
    lastResponseAt: timestamp('last_response_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('rate_limit_states_blocked_until_idx').on(table.blockedUntil),
    check(
      'rate_limit_states_minimum_delay_check',
      sql`${table.minimumDelayMs} > 0`,
    ),
    check(
      'rate_limit_states_last_status_check',
      sql`${table.lastStatus} is null or ${table.lastStatus} between 100 and 599`,
    ),
  ],
);

export const rateLimitEndpointPolicies = pgTable(
  'rate_limit_endpoint_policies',
  {
    endpoint: text('endpoint').primaryKey(),
    policy: text('policy')
      .notNull()
      .references(() => rateLimitStates.policy, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    ...timestamps,
  },
  (table) => [
    index('rate_limit_endpoint_policies_policy_idx').on(table.policy),
  ],
);

export const providerCircuits = pgTable(
  'provider_circuits',
  {
    provider: text('provider').notNull(),
    endpoint: text('endpoint').notNull(),
    status: text('status').default('closed').notNull(),
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    retryAt: timestamp('retry_at', { withTimezone: true }),
    probeLeaseUntil: timestamp('probe_lease_until', { withTimezone: true }),
    lastFailureCode: text('last_failure_code'),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.endpoint] }),
    index('provider_circuits_status_retry_at_idx').on(
      table.status,
      table.retryAt,
    ),
    check(
      'provider_circuits_status_check',
      sql`${table.status} in ('closed', 'open', 'half_open')`,
    ),
    check(
      'provider_circuits_failures_check',
      sql`${table.consecutiveFailures} >= 0`,
    ),
  ],
);

export const gameDataVersions = pgTable(
  'game_data_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    game: text('game').notNull(),
    patchVersion: text('patch_version').notNull(),
    source: text('source').notNull(),
    sourceRevision: text('source_revision').notNull(),
    status: text('status').default('importing').notNull(),
    manifestHash: text('manifest_hash').notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'game_data_versions_status_check',
      sql`${table.status} in ('importing', 'active', 'failed', 'archived')`,
    ),
    uniqueIndex('game_data_versions_active_game_uq')
      .on(table.game)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const canonicalEntities = pgTable(
  'canonical_entities',
  {
    gameDataVersionId: uuid('game_data_version_id')
      .notNull()
      .references(() => gameDataVersions.id, { onDelete: 'cascade' }),
    entityKind: text('entity_kind').notNull(),
    canonicalId: text('canonical_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadHash: text('payload_hash').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.gameDataVersionId, table.entityKind, table.canonicalId],
    }),
    index('canonical_entities_lookup_idx').on(
      table.gameDataVersionId,
      table.entityKind,
      table.canonicalId,
    ),
  ],
);

export const providerMappings = pgTable(
  'provider_mappings',
  {
    gameDataVersionId: uuid('game_data_version_id')
      .notNull()
      .references(() => gameDataVersions.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    entityKind: text('entity_kind').notNull(),
    canonicalId: text('canonical_id').notNull(),
    externalId: text('external_id').notNull(),
    discriminator: text('discriminator'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').default('active').notNull(),
    confidence: integer('confidence').default(100).notNull(),
    sourceRevision: text('source_revision').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.gameDataVersionId,
        table.provider,
        table.entityKind,
        table.canonicalId,
        table.externalId,
      ],
    }),
    index('provider_mappings_resolve_idx').on(
      table.gameDataVersionId,
      table.provider,
      table.entityKind,
      table.canonicalId,
    ),
    check(
      'provider_mappings_status_check',
      sql`${table.status} in ('active', 'disabled')`,
    ),
    check(
      'provider_mappings_confidence_check',
      sql`${table.confidence} between 0 and 100`,
    ),
  ],
);

export const marketTargets = pgTable(
  'market_targets',
  {
    id: uuid('id').primaryKey(),
    digest: text('digest').notNull(),
    profile: jsonb('profile').$type<MarketTarget>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('market_targets_digest_uq').on(table.digest),
    check(
      'market_targets_profile_object',
      sql`jsonb_typeof(${table.profile}) = 'object'`,
    ),
  ],
);

export const marketResearchSnapshots = pgTable(
  'market_research_snapshots',
  {
    id: uuid('id').primaryKey(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => marketTargets.id, { onDelete: 'restrict' }),
    digest: text('digest').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull(),
    dataKind: text('data_kind').notNull(),
    currency: text('currency').notNull(),
    runnerId: text('runner_id'),
    ownerEpoch: bigint('owner_epoch', { mode: 'number' }),
    summary: jsonb('summary').$type<MarketResearchSnapshotSummary>().notNull(),
    listings: jsonb('listings').$type<MarketImportListing[]>().notNull(),
  },
  (table) => [
    uniqueIndex('market_research_snapshots_digest_uq').on(table.digest),
    index('market_research_snapshots_target_time_idx').on(
      table.targetId,
      table.capturedAt,
    ),
    check(
      'market_research_snapshots_kind_check',
      sql`${table.dataKind} in ('observed', 'demo')`,
    ),
    check(
      'market_research_snapshots_currency_check',
      sql`${table.currency} in ('chaos', 'divine')`,
    ),
    check(
      'market_research_snapshots_count_check',
      sql`jsonb_typeof(${table.listings}) = 'array' and jsonb_array_length(${table.listings}) <= 1000`,
    ),
  ],
);

export const marketCollectionSettings = pgTable(
  'market_collection_settings',
  {
    targetId: uuid('target_id')
      .primaryKey()
      .references(() => marketTargets.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    paused: boolean('paused').notNull().default(false),
    intervalMinutes: integer('interval_minutes').notNull().default(60),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    payload: jsonb('payload').$type<MarketCollectionSettings>().notNull(),
  },
  (table) => [
    check(
      'market_collection_settings_interval_check',
      sql`${table.intervalMinutes} between 5 and 1440`,
    ),
    check(
      'market_collection_settings_payload_object',
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    index('market_collection_settings_due_idx').on(
      table.enabled,
      table.paused,
      table.nextRunAt,
    ),
  ],
);

export const marketCollectionRuns = pgTable(
  'market_collection_runs',
  {
    id: uuid('id').primaryKey(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => marketTargets.id, { onDelete: 'restrict' }),
    targetDigest: text('target_digest').notNull(),
    league: text('league').notNull(),
    patch: text('patch').notNull(),
    status: text('status').notNull(),
    trigger: text('trigger').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    runnerId: text('runner_id'),
    ownerEpoch: bigint('owner_epoch', { mode: 'number' }),
    payload: jsonb('payload').$type<MarketCollectionRun>().notNull(),
  },
  (table) => [
    index('market_collection_runs_target_time_idx').on(
      table.targetId,
      table.startedAt,
    ),
    uniqueIndex('market_collection_runs_single_active_uq')
      .on(table.targetId)
      .where(sql`${table.status} = 'running'`),
    check(
      'market_collection_runs_status_check',
      sql`${table.status} in ('running', 'succeeded', 'empty', 'partial', 'blocked', 'rate_limited', 'failed', 'cancelled')`,
    ),
    check(
      'market_collection_runs_payload_object',
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
  ],
);

export const marketCollectionRequests = pgTable(
  'market_collection_requests',
  {
    id: uuid('id').primaryKey(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => marketTargets.id, { onDelete: 'restrict' }),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    requestedBy: text('requested_by'),
    state: text('state').notNull().default('queued'),
    claimOwner: text('claim_owner'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    runId: uuid('run_id').references(() => marketCollectionRuns.id, {
      onDelete: 'set null',
    }),
    errorCode: text('error_code'),
  },
  (table) => [
    index('market_collection_requests_queue_idx')
      .on(table.state, table.requestedAt)
      .where(sql`${table.state} = 'queued'`),
    index('market_collection_requests_target_idx').on(
      table.targetId,
      table.requestedAt.desc(),
    ),
    check(
      'market_collection_requests_state_check',
      sql`${table.state} in ('queued','claimed','completed','cancelled')`,
    ),
    check(
      'market_collection_requests_error_check',
      sql`${table.errorCode} is null or ${table.errorCode} ~ '^[A-Z0-9_]{1,100}$'`,
    ),
  ],
);

export const marketCollectionWorkers = pgTable(
  'market_collection_workers',
  {
    instanceId: text('instance_id').primaryKey(),
    version: text('version').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    state: text('state').notNull(),
    activeRuns: integer('active_runs').notNull().default(0),
    lastErrorCode: text('last_error_code'),
  },
  (table) => [
    check(
      'market_collection_workers_state_check',
      sql`${table.state} in ('starting','healthy','draining','unhealthy')`,
    ),
    check(
      'market_collection_workers_active_runs_check',
      sql`${table.activeRuns} >= 0`,
    ),
    check(
      'market_collection_workers_error_check',
      sql`${table.lastErrorCode} is null or ${table.lastErrorCode} ~ '^[A-Z0-9_]{1,100}$'`,
    ),
  ],
);

export const marketCollectionOwnership = pgTable(
  'market_collection_ownership',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    ownerInstanceId: text('owner_instance_id'),
    ownerEpoch: bigint('owner_epoch', { mode: 'number' }).notNull().default(0),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'market_collection_ownership_singleton_check',
      sql`${table.singleton}`,
    ),
    check(
      'market_collection_ownership_epoch_check',
      sql`${table.ownerEpoch} >= 0`,
    ),
  ],
);

export const beltPriceUpdates = pgTable(
  'belt_price_updates',
  {
    id: uuid('id').primaryKey(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => marketTargets.id, { onDelete: 'restrict' }),
    digest: text('digest').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    dataKind: text('data_kind').notNull(),
    payload: jsonb('payload').$type<BeltPriceUpdate>().notNull(),
  },
  (table) => [
    uniqueIndex('belt_price_updates_digest_uq').on(table.digest),
    index('belt_price_updates_target_time_idx').on(
      table.targetId,
      table.createdAt,
    ),
    check(
      'belt_price_updates_kind_check',
      sql`${table.dataKind} in ('observed', 'demo')`,
    ),
    check(
      'belt_price_updates_payload_object',
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
  ],
);

export const marketEconomySnapshots = pgTable(
  'market_economy_snapshots',
  {
    id: uuid('id').primaryKey(),
    league: text('league').notNull(),
    category: text('category').notNull(),
    payloadHash: text('payload_hash').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    summary: jsonb('summary').$type<MarketEconomySummary>().notNull(),
    payload: jsonb('payload').$type<unknown>(),
  },
  (table) => [
    uniqueIndex('market_economy_snapshots_observation_uq').on(
      table.league,
      table.category,
      table.payloadHash,
      table.capturedAt,
    ),
    index('market_economy_snapshots_time_idx').on(table.capturedAt),
    check(
      'market_economy_snapshots_category_check',
      sql`${table.category} in ('BaseType', 'Currency', 'Essence', 'Fossil', 'Resonator')`,
    ),
  ],
);

export const marketEconomyAttempts = pgTable(
  'market_economy_attempts',
  {
    id: uuid('id').primaryKey(),
    league: text('league').notNull(),
    category: text('category').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    status: text('status').notNull(),
    cacheStatus: text('cache_status'),
    errorCode: text('error_code'),
    snapshotId: uuid('snapshot_id').references(
      () => marketEconomySnapshots.id,
      { onDelete: 'set null' },
    ),
  },
  (table) => [
    index('market_economy_attempts_time_idx').on(table.startedAt),
    check(
      'market_economy_attempts_status_check',
      sql`${table.status} in ('running', 'succeeded', 'failed')`,
    ),
    check(
      'market_economy_attempts_cache_check',
      sql`${table.cacheStatus} is null or ${table.cacheStatus} in ('fetched', 'hit', 'revalidated')`,
    ),
  ],
);

/**
 * Independent cheapest-ask observations, one per recipe revision, league,
 * currency and output source snapshot. Rows are compacted into
 * `recipe_price_daily` after 30 days; see docs/database.md.
 */
export const recipePriceObservations = pgTable(
  'recipe_price_observations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    recipeId: text('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'restrict' }),
    recipeContentHash: text('recipe_content_hash').notNull(),
    leagueId: uuid('league_id')
      .notNull()
      .references(() => poeLeagues.id, { onDelete: 'restrict' }),
    currency: text('currency').notNull(),
    sourceSnapshotDedupeKey: text('source_snapshot_dedupe_key').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    ask: numeric('ask', { precision: 20, scale: 8 }).notNull(),
    craftCost: numeric('craft_cost', { precision: 20, scale: 8 }),
    comparableSellers: integer('comparable_sellers'),
    coverage: text('coverage'),
    sortedSampleComplete: boolean('sorted_sample_complete'),
    evaluationId: bigint('evaluation_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('recipe_price_observations_source_uq').on(
      table.recipeId,
      table.recipeContentHash,
      table.leagueId,
      table.currency,
      table.sourceSnapshotDedupeKey,
    ),
    index('recipe_price_observations_series_idx').on(
      table.recipeId,
      table.recipeContentHash,
      table.leagueId,
      table.currency,
      table.observedAt,
    ),
    index('recipe_price_observations_league_observed_idx').on(
      table.leagueId,
      table.observedAt,
    ),
    index('recipe_price_observations_observed_at_idx').on(table.observedAt),
    check(
      'recipe_price_observations_currency_check',
      sql`${table.currency} in ('chaos', 'divine')`,
    ),
    check(
      'recipe_price_observations_values_check',
      sql`${table.ask} >= 0 and (${table.craftCost} is null or ${table.craftCost} >= 0) and (${table.comparableSellers} is null or ${table.comparableSellers} >= 0)`,
    ),
    check(
      'recipe_price_observations_coverage_check',
      sql`${table.coverage} is null or ${table.coverage} in ('complete', 'partial', 'unknown')`,
    ),
  ],
);

/** Daily UTC OHLC ask and last contemporaneous craft cost per series. */
export const recipePriceDaily = pgTable(
  'recipe_price_daily',
  {
    recipeId: text('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'restrict' }),
    recipeContentHash: text('recipe_content_hash').notNull(),
    leagueId: uuid('league_id')
      .notNull()
      .references(() => poeLeagues.id, { onDelete: 'restrict' }),
    currency: text('currency').notNull(),
    bucketStart: timestamp('bucket_start', { withTimezone: true }).notNull(),
    firstObservedAt: timestamp('first_observed_at', {
      withTimezone: true,
    }).notNull(),
    lastObservedAt: timestamp('last_observed_at', {
      withTimezone: true,
    }).notNull(),
    openAsk: numeric('open_ask', { precision: 20, scale: 8 }).notNull(),
    highAsk: numeric('high_ask', { precision: 20, scale: 8 }).notNull(),
    lowAsk: numeric('low_ask', { precision: 20, scale: 8 }).notNull(),
    closeAsk: numeric('close_ask', { precision: 20, scale: 8 }).notNull(),
    observationCount: integer('observation_count').notNull(),
    craftCost: numeric('craft_cost', { precision: 20, scale: 8 }),
    craftCostObservedAt: timestamp('craft_cost_observed_at', {
      withTimezone: true,
    }),
    minComparableSellers: integer('min_comparable_sellers'),
    lastComparableSellers: integer('last_comparable_sellers'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: 'recipe_price_daily_pk',
      columns: [
        table.recipeId,
        table.recipeContentHash,
        table.leagueId,
        table.currency,
        table.bucketStart,
      ],
    }),
    index('recipe_price_daily_league_bucket_idx').on(
      table.leagueId,
      table.bucketStart,
    ),
    index('recipe_price_daily_bucket_idx').on(table.bucketStart),
    check(
      'recipe_price_daily_currency_check',
      sql`${table.currency} in ('chaos', 'divine')`,
    ),
    check(
      'recipe_price_daily_ohlc_check',
      sql`${table.lowAsk} >= 0 and ${table.lowAsk} <= ${table.openAsk} and ${table.lowAsk} <= ${table.closeAsk} and ${table.highAsk} >= ${table.openAsk} and ${table.highAsk} >= ${table.closeAsk}`,
    ),
    check(
      'recipe_price_daily_times_check',
      sql`${table.firstObservedAt} <= ${table.lastObservedAt} and ${table.observationCount} > 0`,
    ),
    check(
      'recipe_price_daily_cost_check',
      sql`(${table.craftCost} is null) = (${table.craftCostObservedAt} is null) and (${table.craftCost} is null or ${table.craftCost} >= 0)`,
    ),
  ],
);

/**
 * Read-only projection of saved evaluations into price-history candidates.
 * Both the save path and migration 0024's one-time backfill insert from this
 * view, so they share one definition of "usable". JSON fields are validated
 * before any cast; nested CASE keeps the cast behind its guard.
 */
export const recipePriceObservationCandidates = pgView(
  'recipe_price_observation_candidates',
  {
    evaluationId: bigint('evaluation_id', { mode: 'number' }).notNull(),
    recipeId: text('recipe_id').notNull(),
    recipeContentHash: text('recipe_content_hash').notNull(),
    leagueId: uuid('league_id').notNull(),
    currency: text('currency').notNull(),
    sourceSnapshotDedupeKey: text('source_snapshot_dedupe_key').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    ask: numeric('ask', { precision: 20, scale: 8 }).notNull(),
    craftCost: numeric('craft_cost', { precision: 20, scale: 8 }),
    comparableSellers: integer('comparable_sellers'),
    coverage: text('coverage'),
    sortedSampleComplete: boolean('sorted_sample_complete'),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
  },
).as(
  sql`select
  e.id as evaluation_id,
  e.recipe_id,
  e.method_cost->>'recipeContentHash' as recipe_content_hash,
  e.league_id,
  e.currency,
  e.source_snapshot_dedupe_key,
  case
    when e.method_cost->'source'->>'capturedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      and pg_input_is_valid(e.method_cost->'source'->>'capturedAt', 'timestamptz')
    then (e.method_cost->'source'->>'capturedAt')::timestamptz
  end as observed_at,
  e.estimated_sale_price as ask,
  case
    when e.expected_craft_cost is not null
      and coalesce(e.method_cost->'expectedCost'->>'currency', e.currency) = e.currency
      and e.method_cost->>'expiresAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      and pg_input_is_valid(e.method_cost->>'expiresAt', 'timestamptz')
    then case
      when (e.method_cost->>'expiresAt')::timestamptz > e.evaluated_at
      then e.expected_craft_cost
    end
  end as craft_cost,
  case
    when jsonb_typeof(e.method_cost->'source'->'sampleSize') = 'number'
      and pg_input_is_valid(e.method_cost->'source'->>'sampleSize', 'integer')
    then case
      when (e.method_cost->'source'->>'sampleSize')::integer >= 0
      then (e.method_cost->'source'->>'sampleSize')::integer
    end
  end as comparable_sellers,
  case
    when e.method_cost->'source'->>'coverage' in ('complete', 'partial', 'unknown')
    then e.method_cost->'source'->>'coverage'
  end as coverage,
  case
    when jsonb_typeof(e.method_cost->'source'->'sortedSampleComplete') = 'boolean'
    then (e.method_cost->'source'->>'sortedSampleComplete')::boolean
  end as sorted_sample_complete,
  e.evaluated_at
from recipe_evaluations e
where e.status in ('success', 'partial')
  and e.estimated_sale_price is not null
  and e.estimated_sale_price >= 0
  and e.currency in ('chaos', 'divine')
  and e.source_snapshot_dedupe_key is not null
  and jsonb_typeof(e.method_cost) = 'object'
  and jsonb_typeof(e.method_cost->'recipeContentHash') = 'string'`,
);

export const craftOutcomeModels = pgTable(
  'craft_outcome_models',
  {
    id: uuid('id').primaryKey(),
    recipeId: text('recipe_id')
      .notNull()
      .references(() => recipes.id),
    recipeContentHash: text('recipe_content_hash').notNull(),
    targetSignature: text('target_signature').notNull(),
    leagueId: uuid('league_id')
      .notNull()
      .references(() => poeLeagues.id),
    revision: integer('revision').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    document: jsonb('document').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('craft_outcome_models_revision_uq').on(
      t.recipeId,
      t.recipeContentHash,
      t.leagueId,
      t.revision,
    ),
    uniqueIndex('craft_outcome_models_idempotency_uq').on(t.idempotencyKey),
    check('craft_outcome_models_revision_check', sql`${t.revision} > 0`),
  ],
);

export const craftRiskRuns = pgTable(
  'craft_risk_runs',
  {
    id: uuid('id').primaryKey(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => craftOutcomeModels.id),
    recipeId: text('recipe_id')
      .notNull()
      .references(() => recipes.id),
    recipeContentHash: text('recipe_content_hash').notNull(),
    leagueId: uuid('league_id')
      .notNull()
      .references(() => poeLeagues.id),
    calculationVersion: text('calculation_version').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    request: jsonb('request').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull(),
    progress: integer('progress').notNull().default(0),
    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('craft_risk_runs_idempotency_uq').on(t.idempotencyKey),
    index('craft_risk_runs_queue_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'queued'`),
    index('craft_risk_runs_model_idx').on(t.modelId, t.createdAt),
    check(
      'craft_risk_runs_status_check',
      sql`${t.status} in ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')`,
    ),
    check(
      'craft_risk_runs_progress_check',
      sql`${t.progress} between 0 and 100`,
    ),
  ],
);

export const factoryBatches = pgTable(
  'factory_batches',
  {
    id: uuid('id').primaryKey(),
    recipeId: text('recipe_id')
      .notNull()
      .references(() => recipes.id),
    leagueId: uuid('league_id')
      .notNull()
      .references(() => poeLeagues.id),
    document: jsonb('document').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('factory_batches_league_idx').on(t.leagueId, t.createdAt)],
);

export const factoryEvents = pgTable(
  'factory_events',
  {
    id: uuid('id').primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => factoryBatches.id),
    sequence: integer('sequence').notNull(),
    document: jsonb('document').$type<Record<string, unknown>>().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('factory_events_sequence_uq').on(t.batchId, t.sequence),
    uniqueIndex('factory_inventory_identity_uq')
      .on(sql`(${t.document}->'payload'->>'itemId')`)
      .where(sql`${t.document}->'payload'->>'type' = 'produce'`),
    check(
      'factory_events_sequence_check',
      sql`${t.sequence} > 0 and ${t.sequence} <= 2000`,
    ),
  ],
);

export const factoryMutations = pgTable(
  'factory_mutations',
  {
    idempotencyKey: uuid('idempotency_key').primaryKey(),
    requestHash: text('request_hash').notNull(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => factoryBatches.id),
    resultVersion: integer('result_version').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('factory_mutations_version_check', sql`${t.resultVersion} >= 0`),
  ],
);

export const marketCollectorPrivate = pgSchema('market_collector_private');

export const marketTradeSession = marketCollectorPrivate.table(
  'trade_session',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    sealedSession: text('sealed_session').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check('trade_session_singleton_check', sql`${table.singleton}`)],
);

export const collectorSchedule = pgTable(
  'collector_schedule',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    leagueId: uuid('league_id').references(() => poeLeagues.id),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    intervalMinutes: integer('interval_minutes').notNull(),
    nextDueAt: timestamp('next_due_at', { withTimezone: true }).notNull(),
    attempt: integer('attempt').default(0).notNull(),
    retryAt: timestamp('retry_at', { withTimezone: true }),
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    lastStartedAt: timestamp('last_started_at', { withTimezone: true }),
    lastFinishedAt: timestamp('last_finished_at', { withTimezone: true }),
    lastStatus: text('last_status'),
    lastError: text('last_error'),
    enabled: boolean('enabled').default(true).notNull(),
  },
  (table) => [
    uniqueIndex('collector_schedule_kind_key_uq').on(table.kind, table.key),
    index('collector_schedule_enabled_due_idx')
      .on(table.nextDueAt)
      .where(sql`${table.enabled}`),
    check(
      'collector_schedule_kind_check',
      sql`${table.kind} in ('trade-target', 'economy', 'league', 'retention')`,
    ),
    check(
      'collector_schedule_interval_check',
      sql`${table.intervalMinutes} > 0`,
    ),
    check('collector_schedule_attempt_check', sql`${table.attempt} >= 0`),
  ],
);

export const runRequests = pgTable(
  'run_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scope: text('scope').notNull(),
    recipeId: text('recipe_id').references(() => recipes.id),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    state: text('state').default('queued').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    summary: jsonb('summary').$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex('run_requests_queued_scope_recipe_uq')
      .on(table.scope, sql`coalesce(${table.recipeId}, '')`)
      .where(sql`${table.state} = 'queued'`),
    check(
      'run_requests_scope_recipe_check',
      sql`(${table.scope} = 'all' and ${table.recipeId} is null)
        or (${table.scope} = 'recipe' and ${table.recipeId} is not null)`,
    ),
    check(
      'run_requests_state_check',
      sql`${table.state} in ('queued', 'running', 'done', 'failed')`,
    ),
  ],
);

export const collectorState = pgTable(
  'collector_state',
  {
    id: integer('id').default(1).primaryKey(),
    lastRunStartedAt: timestamp('last_run_started_at', { withTimezone: true }),
    lastRunFinishedAt: timestamp('last_run_finished_at', {
      withTimezone: true,
    }),
    lastRunStatus: text('last_run_status'),
    lastRunSummary: jsonb('last_run_summary').$type<Record<string, unknown>>(),
    blockedReason: text('blocked_reason'),
    sessionCheckedAt: timestamp('session_checked_at', { withTimezone: true }),
  },
  (table) => [check('collector_state_singleton_check', sql`${table.id} = 1`)],
);

export const captures = pgTable(
  'captures',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => collectorSchedule.id),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    reportedTotal: integer('reported_total').notNull(),
    fetched: integer('fetched').notNull(),
    complete: boolean('complete').notNull(),
    sortedSampleIds: text('sorted_sample_ids').array(),
    partialReason: text('partial_reason'),
    slices: integer('slices').notNull(),
    // Preserve the source ID after economy snapshot retention expires.
    fxSnapshotId: uuid('fx_snapshot_id'),
    durationMs: integer('duration_ms').notNull(),
  },
  (table) => [
    uniqueIndex('captures_schedule_time_uq').on(
      table.scheduleId,
      table.capturedAt,
    ),
  ],
);

export const listings = pgTable(
  'listings',
  {
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => collectorSchedule.id),
    itemId: text('item_id').notNull(),
    seller: text('seller'),
    fingerprint: text('fingerprint'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    firstCaptureId: uuid('first_capture_id')
      .notNull()
      .references(() => captures.id),
    lastCaptureId: uuid('last_capture_id')
      .notNull()
      .references(() => captures.id),
    priceOriginal: numeric('price_original', { precision: 20, scale: 8 }),
    currency: text('currency'),
    priceChaos: numeric('price_chaos', { precision: 20, scale: 8 }),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    status: text('status').default('active').notNull(),
    missedCompleteCaptures: integer('missed_complete_captures')
      .default(0)
      .notNull(),
    goneAt: timestamp('gone_at', { withTimezone: true }),
    item: jsonb('item').$type<MarketImportListing['item']>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scheduleId, table.itemId] }),
    index('listings_schedule_status_idx').on(table.scheduleId, table.status),
    index('listings_schedule_seller_fingerprint_idx').on(
      table.scheduleId,
      table.seller,
      table.fingerprint,
    ),
    check(
      'listings_status_check',
      sql`${table.status} in ('active', 'missing', 'gone')`,
    ),
    check(
      'listings_missed_complete_captures_check',
      sql`${table.missedCompleteCaptures} >= 0`,
    ),
  ],
);

export const listingEvents = pgTable(
  'listing_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => collectorSchedule.id),
    itemId: text('item_id').notNull(),
    captureId: uuid('capture_id')
      .notNull()
      .references(() => captures.id),
    at: timestamp('at', { withTimezone: true }).notNull(),
    type: text('type').notNull(),
    fromPriceChaos: numeric('from_price_chaos', { precision: 20, scale: 8 }),
    toPriceChaos: numeric('to_price_chaos', { precision: 20, scale: 8 }),
    relatedItemId: text('related_item_id'),
  },
  (table) => [
    index('listing_events_schedule_item_time_idx').on(
      table.scheduleId,
      table.itemId,
      table.at,
    ),
    index('listing_events_schedule_type_time_idx').on(
      table.scheduleId,
      table.type,
      table.at,
    ),
    check(
      'listing_events_type_check',
      sql`${table.type} in ('first_seen', 'price_changed', 'missed', 'reappeared', 'gone', 'possible_relist')`,
    ),
  ],
);

export const recipeResults = pgTable(
  'recipe_results',
  {
    recipeId: text('recipe_id')
      .notNull()
      .references(() => recipes.id),
    leagueId: uuid('league_id')
      .notNull()
      .references(() => poeLeagues.id),
    recipeContentHash: text('recipe_content_hash').notNull(),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
    result: jsonb('result').$type<RecipeResult>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.recipeId, table.leagueId] })],
);
