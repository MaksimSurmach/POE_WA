# Database lifecycle

## Retention

- Delete raw provider payloads by `raw_snapshots.expires_at`; no evaluation has
  a foreign key back to a raw snapshot, so cleanup cannot invalidate results.
- Keep `aggregated_observations` and `recipe_evaluations` for 14 days by their
  indexed `observed_at` and `evaluated_at` timestamps.
- Keep recipes, canonical market queries, refresh cycles, and the current
  catalog pointer longer than observation history. Recipes are deactivated,
  not deleted.

Collector history uses the existing collector retention schedule when
`COLLECTOR_RETENTION_ENABLED=true`. After recipe price compaction, the
maintenance task removes events, listings, captures and terminal requests
outside 30 days in at most 20 bounded batches per run. The worker logs a
warning when it reaches that cap and may have more rows to prune. Listing age uses the
latest observation or absence transition. The 96-hour activity read window,
seven-day relist window, retained listing capture references, current result
and raw price observation provenance, and latest Run now request stay intact.
Historical price aggregates remain available under their existing policy.
Collector telemetry keeps 25 hours of worker attempts for the last-hour and
last-24-hours reports. Counts start at the first recorded HA contact. They may
lag during a capture and lose the last unflushed increments when leadership
is interrupted. The diagnostics endpoint shares a short read cache between
viewers and does not query Trade.

Validate pruning on a restored backup before enabling it for an existing
database.

New captures retain their versioned query key, observed normalized range and
a separate floor only when all listings have a chaos basis and the target has
complete coverage. The conversion rate is retained with its economy snapshot
ID when divine asks are normalized. Historic rows have unknown floors. A stale ask has been
observed with the same original price and currency for seven days, with gaps
no greater than twice the target's scheduled interval. An unpriced sighting,
confirmed miss or reprice resets that observation. The unfiltered asks remain
visible; the floor without stale asks is a separate comparison.

## Price history

Migration `0024_market_price_history.sql` adds two tables and one read-only view:

- `recipe_price_observations`: one row per recipe ID, recipe content hash,
  league, currency and output source snapshot (`source_snapshot_dedupe_key`).
  It holds the cheapest comparable ask at the snapshot's capture time, the
  seller count, coverage, and the expected craft cost when that cost was
  contemporaneous: present, in the same currency, and with every input still
  inside the quote-age window when evaluated.
- `recipe_price_daily`: per-series UTC-day summaries (`date_bin` origin
  `2000-01-01T00:00:00Z`). Each row holds open/high/low/close ask, first and
  last observation times, the independent-snapshot count, the last
  contemporaneous craft cost with its time, and min/last seller counts.
- `recipe_price_observation_candidates`: the shared definition of a usable
  evaluation. Only `success`/`partial` rows qualify, and they need a
  chaos/divine ask, a source snapshot key, a recipe content hash and a
  parseable source time that is not after the evaluation. It never casts
  unvalidated JSON.

`recipe_evaluations` saves insert the observation in the same transaction.
Carried-forward, repeated and stale evaluations of an already-seen snapshot
conflict and are ignored. Saves reject source times more than 5 minutes
ahead of the database clock, and source times older than 30 days, which
covers old snapshots carried forward after their row was rolled up. The
migration backfills existing usable evaluations from the last 730 days once.
The backfill is idempotent.

The daily cleanup job runs the compaction before the existing retention
cleaner. One statement deletes a batch of observations older than 30 days
and merges them into the daily rows. The merge keeps the earliest open and
the latest close and adds counts, so out-of-order and late rows merge
exactly and retries never double count. Daily rows are deleted after
`historyRetentionDays` (default 730, clamped to 31–730). Nothing else is
deleted: `recipe_evaluations`, `aggregated_observations` and
`raw_snapshots` keep their existing policy. Sales and traded volume are
not stored, because listings carry no such evidence.

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

## Single-method recipe upgrade

Migration `0022_single_method_cost.sql` adds a nullable `method_cost` JSON column. It neither rewrites nor drops existing `variant_costs`, snapshots, observations, recipe IDs or evaluation amounts. Historical payloads stay in the database and are not interpreted as current method costs. The current reader requires a matching recipe content hash. Sync the Git catalog after migration; removed definitions are soft-disabled. A PostgreSQL migration test compares historical evaluation and raw-evidence payloads before and after applying the actual SQL.
