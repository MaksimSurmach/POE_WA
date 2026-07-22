import type { Pool } from 'pg';

export function resetIntegrationDatabase(pool: Pool) {
  return pool.query(
    `truncate table craft_probability_results, jobs, recipe_evaluations,
       aggregated_observations, raw_snapshots, catalog_state, market_queries,
       refresh_cycles, recipes, provider_circuits, rate_limit_states,
       poe_leagues restart identity cascade`,
  );
}
