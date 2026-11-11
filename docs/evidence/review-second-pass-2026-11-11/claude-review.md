## Review of PR #102 at `2e23d03` against `origin/master` `0b8504f`

No blocking defects found. One P2 in the craft wake listener is worth fixing before or right after merge, and there are two P3s. This is a code-read review only: I had no shell, so I ran no tests and relied on your report that CI is green.

### P2 — Craft wake listener never reconnects, and the fallback is now 60s instead of 0.5s

- **Where:** `apps/server/src/repositories/craftAnalysisRepository.ts:237-250`, `apps/server/src/craftAnalysis.ts:317-321`
- **Trigger:** any of these leaves the process with no listener:
  - The dedicated `pg.Client` loses its connection (Postgres or pooler restart, failover, idle TCP drop); the `error` handler swallows it and nothing re-listens.
  - The initial `connect`/`LISTEN` fails at `onReady`; it is reported once via `onWorkerError` and never retried.
  - The connection goes half-open; I saw no keepalive configured in `createDatabasePool`, so no `error` may ever fire.
- **Consequence:** until the process restarts, every queued risk simulation waits up to 60s before starting, where master's 500ms poll picked it up almost immediately. A lost connection logs nothing. A startup failure logs under the misleading "Craft risk worker failed" message.
- **Related gap:** `start()` calls `kick()` before `LISTEN` is established, so a run committed between the startup drain's empty claim and the `LISTEN` taking effect also waits for the 60s timer.
- **Smallest fix:** in `listen`, on `error`/`end` when not closing, re-create the client with backoff and call `onWake()` after each successful `LISTEN`. That also closes the startup gap. A cheaper alternative is to keep the fallback interval at a few seconds.
- **Test gap:** `craftAnalysis.test.ts` covers the wake and the `unlisten` call only; nothing covers listener loss or `listen` rejecting.
- **Confidence:** high on the mechanism, medium on how often it happens in production.

### P3 — Mixed-currency proof spends its request budget before it knows the denominations reconcile

- **Where:** `apps/server/src/collectorTrade.ts:359-372`
- **Trigger:** a mixed target with more than 100 listings where the chaos slice alone exceeds 100, and either a third-currency or unpriced ask exists or divine also exceeds 100.
- **Consequence:** the chaos child is fully sliced (up to 4 ranged searches plus their detail fetches) before the divine search runs. The capture then ends `MIXED_CURRENCY_TOTAL_MISMATCH` or `PRICE_SLICE_LIMIT` anyway. Such a target goes from 1 search per capture on master to 6, every cycle, and stays partial. The 601-listing test pins the 6-search count, so the cost is asserted rather than accidental; say if retaining the extra partial evidence is the intent.
- **Smallest fix:** search both denominations first, compare `chaos.total + divine.total` with the root total, and only then recurse. The success path costs the same number of requests.
- **Confidence:** medium. This is a budget regression, not a correctness one.

The completeness proof itself looks sound and fails closed:

- A wrong-currency row inside a denomination slice yields `DETAILS_INCOMPLETE`.
- A third-currency row in the root sample trips the `rows.size !== covered.size` check.
- Churn is caught by the root recheck.

Two things to confirm as intended:

- With the cap of 5, a mixed target can never be proven when both denominations exceed 100 (needs 6), or when chaos exceeds roughly 200.
- Starting-base mixed targets above 100 still short-circuit to `MIXED_CURRENCY_SLICE_UNPROVEN` at `collectorTrade.ts:422-427`, and the new tests do not exercise that path.

### P3 — Cross-target evidence can upgrade an exit but never veto one

- **Where:** `apps/server/src/marketActivity.ts:188-196` (and the drizzle twin at `:141-162`), `packages/domain/src/marketActivity.ts:156-164`
- **Trigger:** item X goes `gone` on target A but is still being captured under the same `item_id` on overlapping target B, and the seller has another item Y seen after the miss.
- **Consequence:** A counts an inferred exit for a listing that demonstrably has not left Trade. Inferred exits feed the readiness gate of 3 or more (`collectorReadiness.ts:153`).
- **Smallest fix:** return a second aggregate from the same query, `max(last_seen_at)` for the same `item_id` on other league targets, and keep the exit `uncertain` when it is at or after `goneAt`.
- **Confidence:** low to medium. It depends on overlapping target queries existing in production. The on-target rule has the same blind spot on master; the PR only widens what counts as a sighting.

Otherwise the exit logic holds:

- The same item on another target is excluded.
- Sightings before the miss are rejected.
- Several listings leaving together fall back to on-target sightings only.
- The two SQL variants are equivalent.
- UI wording stays "inferred exits", never sales.

### Browser pipeline coverage

No defects. The default run now uses the collector fixture; `factory`, `market-freshness` and `two-methods` are pinned to explicit legacy steps, and each server start resets the database. `economics.spec.ts` now runs only on the collector pipeline, which matches production. The deleted `refreshCancellation` files have no remaining importers.

### Verdict

**Mergeable.** I would land the listener reconnect with this PR or immediately after, since it is the only finding that degrades user-visible behaviour compared with master.

### Verification limits

- **Trade's currency option:** the proof assumes a named currency option matches only asks in that denomination. This is modelled only by the test fake; a wrong assumption would produce partial captures, not false completeness.
- **Seller-sightings query cost:** not measured. It probes every league schedule per gone listing and has no row cap, unlike its sibling queries. Run `EXPLAIN ANALYZE` on staging-sized data before trusting the "no new index needed" comment.
- **LISTEN through the pooler:** the staging example URL uses the Supabase pooler on port 5432, where I expect `LISTEN` to work in session mode, but I did not test it. A transaction-mode pooler would deliver nothing.

## Resolution

- Listener startup now rechecks the queue after LISTEN is established. Connection errors are reported. The fallback is bounded at 5 seconds rather than 60; automatic reconnect is deliberately not added. Regression tests cover unavailable notifications and initial subscription failure.
- Both denomination totals must reconcile before any recursive price slicing. A mismatch stops after three searches; the existing five-slice cap is unchanged.
- The SQL and Drizzle readers also collect sightings of the original item. An observation at or after its gone timestamp vetoes an inferred exit. Domain and database regression tests cover an overlapping target, including the presence of another seller item.
- The branch includes master at 0b8504f. Build, typecheck, lint and 68 focused tests passed locally. Database integration and complete browser acceptance are verified by CI.
