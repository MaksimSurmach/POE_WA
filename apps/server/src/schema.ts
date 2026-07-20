import type { RateLimitWindow } from '@poe-worksmith/domain';
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
  pgTable,
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

export const refreshCycles = pgTable(
  'refresh_cycles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
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
      sql`${table.status} in ('queued', 'running', 'published', 'failed', 'superseded')`,
    ),
    check(
      'refresh_cycles_counts_check',
      sql`${table.totalRecipes} >= 0 and ${table.totalQueries} >= 0 and ${table.completedQueries} >= 0 and ${table.completedRecipes} >= 0 and ${table.failedQueries} >= 0 and ${table.failedRecipes} >= 0 and ${table.completedQueries} + ${table.failedQueries} <= ${table.totalQueries} and ${table.completedRecipes} + ${table.failedRecipes} <= ${table.totalRecipes}`,
    ),
    index('refresh_cycles_status_requested_at_idx').on(
      table.status,
      table.requestedAt,
    ),
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
