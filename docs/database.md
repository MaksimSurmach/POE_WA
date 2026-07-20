# Database lifecycle

## Retention

- Delete raw provider payloads by `raw_snapshots.expires_at`; no evaluation has
  a foreign key back to a raw snapshot, so cleanup cannot invalidate results.
- Keep `aggregated_observations` and `recipe_evaluations` for 14 days by their
  indexed `observed_at` and `evaluated_at` timestamps.
- Keep recipes, canonical market queries, refresh cycles, and the current
  catalog pointer longer than observation history. Recipes are deactivated,
  not deleted.

## Atomic publication

Publish a catalog in one transaction:

1. Lock the singleton `catalog_state` row (`id = 1`).
2. Confirm every required recipe evaluation belongs to the candidate cycle.
3. Mark the candidate `refresh_cycles` row as `published`.
4. Move `catalog_state.published_cycle_id` to the candidate, preserve the old
   value in `previous_cycle_id`, increment `revision`, and commit.

Catalog reads resolve evaluations through `catalog_state.published_cycle_id`,
so readers see either the previous complete cycle or the new complete cycle.

## Migration policy

Committed Drizzle SQL migrations are forward-only in shared environments. Add
a corrective migration instead of editing an applied file. Local development
may use `pnpm db:reset` to remove the disposable local volume and replay every
migration. CI starts from an empty PostgreSQL service and runs `pnpm db:migrate`
before integration tests.
