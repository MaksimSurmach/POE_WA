# POE Worksmith market collector architecture

## Context and decisions

- Ship collection as a separate Go process. It can run as a Kubernetes Deployment, a VPS container, or a local binary; it does not require the Worksmith UI or Chromium.
- Keep the existing Node API as the owner of recipes, target editing, craft economics, and presentation. Go owns only scheduled collection, persistence of observations, and worker health.
- Reuse `market_targets`, `market_collection_settings`, `market_collection_runs`, `market_research_snapshots`, and `rate_limit_states`. The Node contracts in `packages/contracts/src/market.ts` are the cross-language storage contract: the API parses run and snapshot JSON with strict Zod schemas.
- For unattended collection, implement only an approved documented source adapter (candidate: GGG Public Stash API). The official Trade Search site remains a human-driven link/capture step unless GGG authorizes a server API. Do not store `POESESSID` or Cloudflare clearance in this service.
- The collector stores observations, not conclusions: listing asks stay labeled as asks; partial, stale, and incomplete samples remain explicit.

GGG's [developer documentation](https://www.pathofexile.com/developer/docs) limits supported access to documented resources and calls for following response rate-limit headers. Cloudflare says `cf_clearance` is tied to the visitor/device that passed the challenge ([clearance docs](https://developers.cloudflare.com/cloudflare-challenges/concepts/clearance/)). Neither a proxy tunnel nor a browser cookie is a collector integration contract.

## Existing seams to preserve

- `MarketCollectionManager` is constructed in the Node process; its periodic scheduler starts only in worker/all modes. API manual-collect routes and `managedCollectionSource` for recipe workers still call the Node manager directly. A separate worker therefore needs `MARKET_COLLECTION_RUNNER=go` to disable Node schedule and all Node network collection, and route both manual paths through the Go request queue. Running both owners would duplicate requests.
- `market_collection_settings` already stores enabled/paused/interval/next-run state (5–1440 minutes). `market_collection_runs` stores per-run status and has a partial unique index preventing two `running` rows for one target. It also has `heartbeat_at`; current stale-run recovery scans all stale running rows, so Go must use an owner epoch and only recover rows whose ownership expired.
- The existing API reads `market_research_snapshots`, while the Node writer can retain partial raw outcomes. “Only complete observations replace the current price input” is a proposed policy, not current behavior. Preserve existing target/digest, league/patch, currency, freshness, `inexact`, and `observed`/`demo` checks; completeness is an additional requirement, not a replacement. Preserve partial and legacy-unknown observations in history, but exclude them from observed recommendation inputs. Explicit demo previews remain isolated as demo. Fake-source output is always `dataKind=demo` and is never used as an observed input; if no eligible observed snapshot exists, report unavailable rather than falling back to demo or stale data.
- `market_worker_health` is used by the catalog worker; do not overload it for this service.

## Proposed repository shape

```text
services/market-collector/
  cmd/market-collector/main.go
  internal/config/        # env parsing and validation
  internal/store/         # pgx queries and transactions only
  internal/collector/     # scheduler, claim, run lifecycle
  internal/source/        # source interface and documented providers
  internal/http/           # health/readiness and metrics/status
  internal/contracts/     # Go structs matching persisted JSON
```

Build a static, non-root image with a multi-stage Dockerfile. The same binary accepts environment configuration and runs unchanged outside Kubernetes.

## Data flow and ownership

1. API/UI saves a target and its collection settings to Postgres.
2. API manual “collect now” enqueues a request for Go; it does not perform network collection itself in `MARKET_COLLECTION_RUNNER=go` mode. Scheduled settings remain the source of periodic work.
3. Go polls the database, reads global pause/concurrency controls and enabled due targets, then claims work transactionally. Use `SELECT ... FOR UPDATE SKIP LOCKED` plus a transaction that advances `next_run_at` and creates the `running` run row together. The unique active-run index remains the second fence.
4. A source adapter makes bounded requests, follows the source's rate-limit headers, normalizes listings, and reports coverage/counts/timestamps. A generated official Trade URL may be stored for human review; the worker does not scrape that page.
5. Go checkpoints progress into the existing run payload. On completion it writes the run and immutable research snapshot in one transaction. A failed or partial run never replaces the latest complete observation.
6. Node API reads the same tables and serves current UI/economics. No analysis logic is ported to Go.

The manual queue is needed to preserve the API “collect now” route and recipe `managedCollectionSource` without keeping a second collector. Add an additive `market_collection_requests` table with `id`, `target_id`, `requested_at`, `requested_by`, `claimed_at`, `claim_expires_at`, `run_id`, and a constrained queued/claimed/completed/cancelled state. Claiming a request and inserting its run row must be one transaction. An expired claim is not requeued while its linked run is still `running` under the current owner epoch. Return a dedicated queued-request response schema; do not manufacture a `running` collection-run response.

For a Public Stash feed, persist the source cursor in `market_collection_checkpoints` and commit each page's observations and next cursor atomically. A cursor is realm-wide and the feed includes unlisting/deletion events; it is not a per-target search endpoint. The EDD must define baseline bootstrap, replay/idempotency, and removal handling before enabling this source.

Prevent split-brain across a home/VPS/cluster launch with a singleton `market_collection_ownership` row holding `owner_instance_id`, monotonically increasing `owner_epoch`, and `lease_expires_at`. Renewal and takeover are atomic. Every claim, heartbeat, checkpoint, recovery, run update, and snapshot publication transaction verifies the current owner+epoch; stale workers cannot write after takeover even if an in-flight HTTP request completes. Verify ownership before every provider request and cancel on loss. Drain and stop existing Node worker runs before switching the configured owner.

## Worker health and operational data

- Existing `market_collection_runs` is the durable per-target outcome log: succeeded, empty, partial, blocked, rate-limited, failed, or cancelled, with counts and timestamps.
- Add `market_collection_workers`, one row per process instance: `instance_id`, `version`, `started_at`, `heartbeat_at`, `state`, `active_runs`, and `last_error_code`. Add `runner_id` and `owner_epoch` to run rows; upsert heartbeat every 30 seconds; mark `draining` on SIGTERM; expire stale instances in reads after a documented threshold.
- Derive success/failure totals from run rows instead of maintaining duplicate counters in the health row. This avoids counter drift after crashes.
- Expose `/health/live`, `/health/ready` (database ping and schema compatibility; require current owner lease only when the worker is enabled), and a private `/status` JSON view. Prometheus `/metrics` can be added only if the cluster actually scrapes it; database rows remain the durable record.
- Logs are structured JSON with `instance_id`, `run_id`, `target_id`, source, status, duration, counts, and sanitized `error_code`. Never log cookies, connection URLs, full provider response bodies, or raw headers.

## Go module contracts (example)

Use `pgxpool` with context deadlines. Keep database I/O inside `store`; the orchestration layer owns the run lifecycle; adapters own source protocol details.

```go
type Source interface {
    Collect(ctx context.Context, target Target) (Batch, error)
}

type OwnerToken struct {
    InstanceID string
    Epoch      int64
}

type Store interface {
    RenewOwnership(ctx context.Context, instanceID string) (OwnerToken, error)
    ClaimDue(ctx context.Context, owner OwnerToken, limit int) ([]Claim, error)
    Heartbeat(ctx context.Context, owner OwnerToken, state WorkerState) error
    SaveProgress(ctx context.Context, owner OwnerToken, runID string, batch Batch) error
    FinishRunAndPublish(ctx context.Context, owner OwnerToken, runID string, result Result) error
}

func (w *Worker) Run(ctx context.Context) error {
    ticker := time.NewTicker(w.pollInterval)
    defer ticker.Stop()
    for {
        owner, err := w.store.RenewOwnership(ctx, w.instanceID)
        if err != nil {
            w.logger.Error("ownership renewal failed", "error_code", "DB_OWNERSHIP")
        } else if err := w.store.Heartbeat(ctx, owner, w.state()); err != nil {
            w.logger.Error("worker heartbeat failed", "error_code", "DB_HEARTBEAT")
        }
        var claims []Claim
        if err == nil {
            claims, err = w.store.ClaimDue(ctx, owner, w.concurrency)
        }
        if err != nil {
            w.logger.Error("claim failed", "error_code", "DB_CLAIM")
        } else {
            w.runClaims(ctx, claims)
        }
        select {
        case <-ctx.Done(): return ctx.Err()
        case <-ticker.C:
        }
    }
}
```

Use a context timeout per database and source operation. Retry only transient transport/5xx failures with capped exponential backoff and jitter. Classify 401/403 or an explicit challenge as blocked; classify 429 as rate-limited and honor `Retry-After`; treat other 4xx as permanent request failures and stop retrying that request. Bound one run to the existing contract limits (100 batches and 1,000 listings) until the API schema is deliberately versioned.

The `pgxpool` transaction must explicitly roll back on every non-commit path and on cancellation; pgx transaction contexts do not automatically roll back a transaction just because the context is cancelled. See the [pgx transaction and pool docs](https://github.com/jackc/pgx).

## Configuration

Required: `DATABASE_URL`, `COLLECTOR_INSTANCE_ID`, and source selection. Validate Postgres URL and require TLS for hosted Neon connections. Optional bounded settings: `COLLECTOR_POLL_INTERVAL`, `COLLECTOR_CONCURRENCY`, `COLLECTOR_REQUEST_TIMEOUT`, `COLLECTOR_HEARTBEAT_INTERVAL`, and `COLLECTOR_HTTP_ADDR`. Secrets come from the runtime secret store; none are checked into the repository.

Use a least-privilege database role: read targets/settings/admin controls; write collection requests, runs, snapshots, rate-limit state, and worker health. Do not grant schema ownership to the running service.

## Rollout, migration, and rollback

1. Additive migration creates the request and worker-health tables. Existing readers continue to work.
2. Deploy the Go worker disabled (`COLLECTOR_ENABLED=false`) and verify DB connectivity/health only.
3. Set Node `MARKET_COLLECTION_RUNNER=go`: disable Node scheduling and change manual collect to enqueue only. Verify no scheduled collection is active in Node.
4. Enable Go with one instance and one target. Confirm run JSON parses through the existing Node contract, the published snapshot appears in the existing UI, and heartbeats/terminal statuses are visible.
5. Increase target count and concurrency only after observing DB latency, provider limits, memory, and listing coverage.
6. Roll back by disabling Go and restoring Node ownership only for a permitted source. If no permitted source is configured, keep collection paused; do not fall back to undocumented Trade endpoints.

Migrations are additive; rollback disables the worker and leaves historical runs/snapshots intact. Remove the new tables only in a later migration after verifying no worker or API version reads them.

## Contract and quality gates

- Keep golden JSON fixtures for target, run, listing, and snapshot payloads. Parse Go-produced fixtures through the Node Zod schemas and verify the reverse read path.
- Unit-test schedule claiming, retry classification, bounds, cancellation, and idempotent snapshot publication. Integration-test two concurrent workers against Postgres to prove one claim/run per target.
- Add a Go CI job for `gofmt`, `go vet`, and `go test ./...`; keep the existing Node quality job for API contracts/UI.
- Deploy only after health checks, migration compatibility, one-target end-to-end collection, and rollback have been demonstrated.

## Open decision for the EDD

The first unattended source candidate is the documented Public Stash feed, subject to a short feasibility spike for OAuth scope/client availability and whether its realm-wide feed can match stored `market_targets` fields at useful coverage. GGG currently says it cannot process new API application registrations, so do not send provider requests until an authorized `service:psapi` client/scope is confirmed. Exact Trade Search remains human-driven until GGG provides a supported server integration. If the feed cannot meet target-matching requirements, ship worker health/request plumbing first and use the existing manual snapshot import rather than inventing an undocumented endpoint.

## Home Assistant OS

Copy `services/market-collector` to the local apps directory as
`poe_market_collector`. Reload the app store and install
`local_poe_market_collector` under **Local apps**. Supervisor builds for the
host architecture. The same Dockerfile also builds a standalone container.

The app starts in standby with `enabled: false`. With no database configured,
liveness responds successfully and readiness returns 503. For an isolated
smoke test, migrate a PostgreSQL database whose name ends in `_test`, set
`database_url` in the app configuration, and enable it. Home Assistant uses
verified TLS by default. Use a dedicated database user and an explicit
`sslmode=verify-full` for hosted PostgreSQL. The add-on reads its own settings
through the Supervisor API and does not request elevated permissions or
publish a host port.

Inspect the app logs with `ha apps logs local_poe_market_collector`. Startup,
lease acquisition, completed demo runs and changes in polling health emit JSON
logs. The existing database run and worker tables retain operational status.
After an isolated smoke test, stop the app, remove its test DSN, set
`enabled: false` and start it in standby.

This build's fake source only completes demo runs with partial coverage.
Live source rollout and production runner cutover require an authorized
provider and separate verification.

## One-shot Trade collection

The Node one-shot command uses the #36 Trade-compatible adapter, saved target
profiles, database rate limits, and the existing snapshot publisher. It can
run from the server Docker image or a separate Node process on ARM64. It starts
no scheduler.

Apply the migrations and provision a 32-byte hex `POE_TRADE_SESSION_KEY`
outside PostgreSQL. Supply the database DSN through the runtime secret
environment. Send the saved website session to `pnpm market:trade store-session`
over stdin. PostgreSQL stores an AES-256-GCM ciphertext in the private
`market_collector_private` schema. The command prints status only. Keep the key
in a separate secret store and use the same key for storing and collecting.

Run `pnpm market:trade collect <target-id>` with `POE_TRADE_ACCESS=owner_permitted`
and a configured `POE_TRADE_USER_AGENT`. A completed run reports its snapshot ID,
status, and coverage. The existing market API reads the resulting snapshot.
The command respects persisted provider denials and manual collection controls.
Storing a replacement session clears Trade HTTP 401 blocks while retaining
HTTP 403 blocks and rate-limit windows.

## Scheduled Trade collection on Home Assistant

Build the server with `pnpm --filter @poe-worksmith/server... build`. Prepare its
production dependencies with
`pnpm --filter @poe-worksmith/server deploy --prod --legacy <staging-dir>`.
Copy `services/market-trade-scraper` to the Home Assistant local apps directory,
then copy the staged `package.json`, `node_modules`, current server `dist`, and
repository `recipes` directory into its `runtime` directory. On macOS, set `COPYFILE_DISABLE=1` when creating the tar archive.
Reload the app store and install or update `local_poe_trade_scraper`.

Set the app's database DSN and existing encryption key in Supervisor options.
With an empty target ID, the add-on starts the dedicated Node collector and
publishes to `captures`, `listing_events`, and `recipe_results`. It uses a direct
connection for the PostgreSQL lock and wake notifications. For a standard Neon
pooler URL the add-on derives the direct hostname. New Trade schedules start a
minute apart. The add-on runs with two pool connections plus the leader session,
and with retention disabled. It uses the sealed Trade session. Renew an expired
session separately, since this image has no Chromium installation.

A nonempty target ID keeps the legacy single-profile behavior and its database
connection unchanged.

With game data and Trade mappings loaded, run
`node apps/server/dist/entrypoints/scheduleTradeCatalog.js` to preview the
current league's recipe bases and outputs. Add `--apply` to create schedules
for validated profiles. Existing schedules are preserved. New schedules run
every two hours, with initial start times staggered by two minutes. The application's general refresh
scheduler is independent. The worker reads the stored Trade session for each run. Restart it after
rotating an expired session if the previous credential blocked the worker.

Inspect `ha apps logs local_poe_trade_scraper` for terminal runs and snapshot IDs.
The shared rate limiter applies to all requests. A provider denial stops further
requests until the access issue is resolved. A partial snapshot retains the
observed listings and its coverage.
