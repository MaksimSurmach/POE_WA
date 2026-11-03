# Market administration

`/admin/market` controls the existing market engine. It uses the same PostgreSQL
repositories, pg-boss queue, collection manager and provider rate limits as the
recipe handbook. No additional service or authentication platform is required.

## Local access

Run Node 22, pnpm 11 and PostgreSQL 17. Configure the existing development database,
apply migrations, build and start the API/worker:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
pnpm start
```

In another terminal, run the existing frontend:

```sh
pnpm --filter @poe-worksmith/web exec vite --host 127.0.0.1
```

Open [the local admin page](http://127.0.0.1:5173/admin/market). The Vite proxy
preserves the original Host header so browser writes pass same-origin validation.
For split processes, use `pnpm start:api` and `pnpm start:worker` with the same
database and `PG_BOSS_SCHEMA`. `start:market` now uses the shared API entrypoint
and requires PostgreSQL; it does not start the legacy Trade worker.

Remote administrative authentication has **not** been established. Admin reads,
all market writes and `POST /api/refresh` accept direct loopback connections only.
They reject nonlocal peers, nonlocal Host values, forwarding headers and
cross-origin browser requests. Keep the API and frontend bound to loopback. An
SSH tunnel to those local services can provide access; a public reverse proxy or
Docker port mapping does not itself satisfy this boundary. In particular, a
container connection arriving from a bridge address is rejected. Do not rewrite
remote requests to impersonate loopback. Public handbook read endpoints remain
available.

There is no operator token in the frontend, browser storage or admin payloads.
Existing credentials, provider authorization, TLS and deployment controls remain
environment-owned. The existing bearer-protected refresh diagnostics endpoint
retains its server-side token configuration.

## Settings and application

Settings live in `market_admin_settings`, with a monotonically increasing
`version`. Every patch requires that version; concurrent/stale writes return 409.
Unknown fields, invalid relationships and values outside the limits return 400.
Initial TTL is capped at the default 30-minute maximum quote age, and the seed is
validated before insertion. An operator can later raise both values together.
History retention must be at least as long as raw retention; a shorter history
would otherwise remove a row while its raw payload should still be retained.
Settings changes and run/cancel requests are audited transactionally. Legacy
market writes record a request before executing and an outcome afterward; an
unavailable audit store prevents new legacy writes.

| Setting                 | Initial default                       | Bounds / behavior                                                               |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| Automatic refresh       | Enabled                               | Both automatic flags must be on for scheduled source queries                    |
| Scheduled observations  | Enabled globally                      | Individual profiles remain opt-in                                               |
| Pause new collections   | Off                                   | Blocks new scheduled/manual observations and refreshes                          |
| Manual refresh          | Enabled                               | Available when unpaused and a worker is healthy                                 |
| Refresh cron            | `0 */4 * * *`                         | Five-field cron; at least five minutes between occurrences; deployment timezone |
| Market request timeout  | Deployment value, normally 15 seconds | 1–30 seconds; applies to new Trade transport and poe.ninja requests             |
| Collection concurrency  | Deployment value, normally 4          | 1–4, capped by `MARKET_CONCURRENCY`                                             |
| Snapshot reuse TTL      | Normally 30 minutes                   | 1 second–2 hours, no greater than maximum quote age                             |
| Freshness warning       | 15 minutes                            | 1 minute–maximum quote age                                                      |
| Maximum quote age       | 30 minutes                            | 1 minute–2 hours                                                                |
| Raw retention           | 90 days                               | 24 hours–90 days                                                                |
| Price-history retention | 730 days                              | 14–730 days                                                                     |

GET settings returns `configured`, `effective`, the version, deployment timezone,
warnings and `restartRequired`. All settings listed here are supported at runtime:
new runs/requests read the database, and the scheduler reconciles within five
seconds. Active requests retain their starting timeout; active observations and
already admitted refreshes may finish. Pause does not abort them. Resume clears
the pause without re-enabling automatic settings that were explicitly disabled.
Per-profile interval settings and provider authorization continue to apply.

Collection interval determines **when to request new observations**. Reuse TTL
determines **whether an existing observation can avoid another request**. Maximum
quote age determines **whether a price remains usable**. The default four-hour
schedule and 30-minute TTL leave a freshness gap; the UI warns about it.
Retention controls storage, not freshness. A longer retention or TTL never
changes an observation's capture time. Shorter quote-age settings invalidate
existing price views immediately, without deleting evaluations. Unprovable older
legacy inputs fail closed under a stricter age policy.

The admin page starts with scope and Run now, then compact market state and recent
results. Select one recipe by its catalog title; manual ID entry remains available
when catalog loading fails. Terminal rows expose details on demand, More runs keeps
older history accessible, and active runs stay visible with Cancel available.

Settings opens the complete grouped form with one disclosure. Pause and
compare-latest preserve unrelated edits; Discard edits removes them. Dirty/error
state opens the form; polling preserves its disclosure state and focus. Inactive
configuration warnings stay in Settings; live operational warnings remain visible.
Admin HTTP requests and recipe-list loading have a 15-second UI timeout.

## Runs and cancellation

| API under `/api/admin/market`      | Operation                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /status`                      | League confirmation, provider state, worker/settings heartbeat, next refresh, active/last runs, coverage and cooldowns |
| `GET /settings`, `PATCH /settings` | Read or persist settings with optimistic concurrency                                                                   |
| `POST /refresh`                    | `{ "scope": "all" }`, `{ "scope": "economy" }`, or `{ "scope": "recipe", "recipeId": "…" }`                            |
| `POST /pause`, `POST /resume`      | `{ "version": 0 }`; change admission without deleting history                                                          |
| `GET /runs`                        | Last 50 refreshes, status, duration, planned/completed/failed queries, source freshness and cooldown                   |
| `POST /runs/:id/cancel`            | Request cooperative cancellation; queued jobs are cancelled directly                                                   |

Manual and scheduled refreshes share the exclusive `catalog.full-refresh` queue
and one database admission constraint. Manual enqueue, its run record and its
audit entry commit together. Duplicate manual requests cannot start simultaneous
refreshes. Selected-recipe refreshes collect only that recipe's dependencies and
carry other published evaluations forward without advancing their timestamps.
Economy-only refreshes use the existing permitted public poe.ninja client and
record category progress, failures and cooldowns.

Cancellation is checked every second and before publication. Trade requests
receive an abort; an in-flight economy HTTP request may finish within its timeout
before the next category is stopped. The publication transaction locks the run
record and checks cancellation. A cancellation committed first prevents
publication; a publication committed first makes a late cancellation return 409.
Partial observations and prior published prices remain available.

Workers heartbeat every five seconds. pg-boss heartbeat detection covers worker
loss; its one-hour active-job bound aborts the handler. Queue records are retained
for 24 hours, while a manually queued run that has not started after one hour is
explicitly failed and cancelled. Reconciliation fails interrupted cycles and
their unfinished jobs without deleting snapshots. A recovered database pool can
resume reconciliation; transient connection errors do not permanently poison
readiness. No provider 401/403/429, challenge or cooldown is bypassed.
Queue expiry claims the still-queued run atomically; a worker that starts it
concurrently keeps its active run and is not expired by the old enqueue age.
An individual cancellation-check database failure logs a warning and retries on
the next tick; the publication transaction still checks the cancellation flag.
A pg-boss abort or runtime shutdown is recorded as a worker interruption, separately from an operator
cancellation. Direct API clients can enqueue while the worker is unavailable;
the UI disables Run now until its heartbeat is healthy.

## Retention

The existing scheduled cleanup reads current retention settings. It trims raw
economy payloads, research listing details and archived collection payloads
separately from their price summaries. Summaries retain count/median and expose
`rawAvailable: false`; raw-dependent belt analysis returns 404 after raw expiry.
History expires on its own policy. Unarchived collection results are retained for
publication recovery. Existing protections for active/published legacy snapshots
also remain in place, so pinned records can exceed the raw retention period.

No persistence-disable switch exists. Disabling a schedule or pausing collection
does not run cleanup or invalidate stored historical records.

## Verification

See [the acceptance evidence](evidence/market-admin-2026-11-02/validation.md) and
[the UI review and correction](evidence/market-admin-ui-2026-11-02/validation.md), plus
[the UX distillation](evidence/market-admin-ux-2026-11-02/README.md).
Live Trade collection is deployment-authorized separately and was not enabled by
this change. Normal provider limits and independently configured profile opt-in
still apply after an administrator enables automatic settings.
