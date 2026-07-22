import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  aggregatedObservations,
  catalogState,
  craftProbabilityResults,
  jobs,
  marketQueries,
  poeLeagues,
  providerCircuits,
  rawSnapshots,
  rateLimitEndpointPolicies,
  rateLimitStates,
  recipeEvaluations,
  recipes,
  refreshCycles,
} from './schema.js';

const tables = [
  recipes,
  marketQueries,
  poeLeagues,
  rawSnapshots,
  aggregatedObservations,
  recipeEvaluations,
  refreshCycles,
  catalogState,
  jobs,
  rateLimitStates,
  rateLimitEndpointPolicies,
  providerCircuits,
  craftProbabilityResults,
];

describe('PostgreSQL schema', () => {
  it('declares the complete persistence baseline', () => {
    expect(tables.map((table) => getTableConfig(table).name)).toEqual([
      'recipes',
      'market_queries',
      'poe_leagues',
      'raw_snapshots',
      'aggregated_observations',
      'recipe_evaluations',
      'refresh_cycles',
      'catalog_state',
      'jobs',
      'rate_limit_states',
      'rate_limit_endpoint_policies',
      'provider_circuits',
      'craft_probability_results',
    ]);
  });

  it('covers deduplication, freshness, cycle, and job access paths', () => {
    const indexNames = tables.flatMap((table) =>
      getTableConfig(table)
        .indexes.map((indexDefinition) => indexDefinition.config.name)
        .filter((name): name is string => typeof name === 'string'),
    );

    expect(indexNames).toEqual(
      expect.arrayContaining([
        'recipes_content_hash_uq',
        'market_queries_canonical_hash_uq',
        'raw_snapshots_dedupe_key_uq',
        'raw_snapshots_expires_at_idx',
        'recipe_evaluations_refresh_cycle_id_idx',
        'refresh_cycles_single_running_uq',
        'jobs_pending_run_after_idx',
        'rate_limit_states_blocked_until_idx',
        'rate_limit_endpoint_policies_policy_idx',
        'provider_circuits_status_retry_at_idx',
      ]),
    );
  });
});
