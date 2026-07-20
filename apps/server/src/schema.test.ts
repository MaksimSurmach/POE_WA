import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  aggregatedObservations,
  catalogState,
  jobs,
  marketQueries,
  rawSnapshots,
  recipeEvaluations,
  recipes,
  refreshCycles,
} from './schema.js';

const tables = [
  recipes,
  marketQueries,
  rawSnapshots,
  aggregatedObservations,
  recipeEvaluations,
  refreshCycles,
  catalogState,
  jobs,
];

describe('PostgreSQL schema', () => {
  it('declares the complete persistence baseline', () => {
    expect(tables.map((table) => getTableConfig(table).name)).toEqual([
      'recipes',
      'market_queries',
      'raw_snapshots',
      'aggregated_observations',
      'recipe_evaluations',
      'refresh_cycles',
      'catalog_state',
      'jobs',
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
        'jobs_pending_run_after_idx',
      ]),
    );
  });
});
