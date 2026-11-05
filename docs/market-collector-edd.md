# Market collector EDD

Status: draft for independent Astra review. This document turns `market-collector-architecture.md` into implementation slices and acceptance criteria.

## Objective

Move market collection out of the Node API process into a standalone Go service that can run on Kubernetes, a VPS, or a home server. The service reads collection intent from Postgres, claims work safely, persists observation/run data consumed by the existing Node API, and publishes durable health/status.

The worker must not access undocumented Trade Search/Fetch endpoints, replay `POESESSID`/Cloudflare cookies, automate challenge solving, or use stealth/proxy rotation. The only unattended network source in scope is a documented GGG API whose client/scope is authorized. Human-driven Trade UI results continue through the existing manual snapshot import path.

## Source access gate — do this before provider implementation

1. Confirm the existing owner-controlled OAuth client can request the documented Public Stash service scope (`service:psapi`) and that the credentials are valid for this use. Do not log or paste credentials into the repo or agent prompt.
2. If there is no eligible client/scope, stop the provider slice. GGG currently says it cannot process new application registrations. Implement the worker runtime with a fake source and manual-ingest path only; do not probe an undocumented endpoint.
3. Confirm API rate-limit headers, page cursor behavior, deletion/unlisting events, payload size, and whether public stash records can satisfy the app's target matching requirements. Record measured baseline/cursor lag and representative target coverage.
4. If the feed cannot provide complete target coverage, label observations partial; do not promote them into the current complete snapshot. Exact trade search remains manual until GGG documents/authorizes a server integration.

## Slices and file surfaces

### Slice A — API ownership mode and database contract

Expected files:

- `apps/server/drizzle/0028_market_collector.sql` and schema metadata.
- `apps/server/src/config.ts` for `MARKET_COLLECTION_RUNNER=node|go`, defaulting to `node` for backward compatibility.
- `apps/server/src/process.ts`, `apps/server/src/marketCollectionSource.ts`, and market admin routes to prevent Node from doing collection when `runner=go`.
- `packages/contracts/src/market.ts` for new durable run/status/request fields if shared by HTTP responses.

Migration requirements:

- Add `market_collection_requests`: UUID, target FK, requested timestamp/actor, state (`queued`, `claimed`, `completed`, `cancelled`), claim owner/deadline, run FK, and sanitized error code. Add indexes for queued age and target lookup. A claim-expiry sweep must not requeue a request whose linked run remains `running` under the current owner epoch.
- Add `market_collection_workers`: instance ID PK, version, started/heartbeat timestamps, state (`starting`, `healthy`, `draining`, `unhealthy`), active run count, and sanitized last error code. Do not store duplicate cumulative success/failure counters; derive them from run rows.
- Add singleton `market_collection_ownership` with `owner_instance_id`, monotonically increasing `owner_epoch`, and `lease_expires_at`. Takeover increments the epoch atomically. A Postgres advisory lock may be an extra fast-path, but it is not the fencing mechanism.
- Add source cursor/checkpoint storage keyed by provider and realm. Each feed page's normalized data and advanced cursor commit in one transaction. Include an idempotency key/index so replay after restart cannot double-count or resurrect unlisted items.
- Add `runner_id` and `owner_epoch` to `market_collection_runs`. Every claim, heartbeat, checkpoint, recovery, run update, and publication transaction must assert the active owner ID+epoch. If the epoch changes during an in-flight provider request, the old worker cancels and its later writes fail. Stale recovery only touches rows owned by expired epochs.
- Use existing optional `coverage` in `marketResearchSnapshotSchema` for new snapshot summaries. Require `summary->>'coverage' = 'complete'` in addition to existing target/digest, league/patch, currency, freshness, `inexact`, and `observed`/`demo` checks for observed recommendation inputs. Missing/legacy coverage is `unknown` and stays in history but is not used for observed recommendations. Explicit demo previews remain isolated and labeled demo; fake-source output cannot become an observed price input. If there is no eligible observed snapshot, return unavailable rather than falling back to demo or stale data. Partial outcomes remain in `market_collection_runs`; they do not publish current snapshots.

Coordination requirements:

- A process renews the singleton DB ownership lease (30-second heartbeat, 90-second expiry). On takeover, the database increments `owner_epoch`; every write path checks the token in the same transaction. A lost lease cancels in-flight provider work and forbids further writes. Advisory lock may be used as an optimization, never as sole write fencing.
- Due targets are claimed in a transaction using `FOR UPDATE SKIP LOCKED`; schedule advancement and creation of a `running` run record commit together. Existing `market_collection_runs_single_active_uq` remains the second fence. A uniqueness conflict rolls back schedule advancement.
- Manual requests are claimed with an expiring owner/deadline. Request claim and run-row creation are atomic. An expired claim is requeued only after checking the linked run is not `running` under the current epoch; an active run is never enqueued a second time.
- Standardize the env name as `MARKET_COLLECTION_RUNNER=node|go`. In `go` mode Node's periodic scheduler is off, `configuredCollectionSource` is not started, manual collect routes enqueue only, and `managedCollectionSource` in recipe workers enqueues/waits for the Go run (or returns controlled unavailable on timeout); no Node network fallback is permitted. API response uses a new `marketCollectionRequestResponseSchema` containing `requestId` and `status: queued`; the current run response schema requires a real run. Update API client/UI types to display queued state and poll the linked run.

Node→Go handoff: deploy API `MARKET_COLLECTION_RUNNER=go` first to stop new Node network work and redirect all collection callers; signal the Node collection worker to drain/cancel; wait until no Node-owned run is active and its worker is draining/expired; then enable Go. Do not start Go before this gate passes.

### Slice B — standalone Go runtime (no provider traffic)

Repo layout:

```text
services/market-collector/
  cmd/market-collector/main.go
  internal/config/
  internal/store/postgres/
  internal/collector/
  internal/source/
  internal/http/
  internal/contracts/
```

Use `pgxpool` and `context.Context`. Store owns SQL; collector owns polling/claims/run lifecycle; each provider adapter owns its own protocol. The worker loop is bounded by poll interval, concurrency, request timeout, max batches, and max listings. On SIGTERM, stop claiming, mark `draining`, cancel active contexts, persist terminal run states, and release the advisory lock.

Configuration: `DATABASE_URL`, `DATABASE_SSL_MODE=require` for hosted Neon, `COLLECTOR_INSTANCE_ID`, `COLLECTOR_ENABLED`, `COLLECTOR_POLL_INTERVAL`, `COLLECTOR_CONCURRENCY` (1 initially), `COLLECTOR_REQUEST_TIMEOUT`, `COLLECTOR_HEARTBEAT_INTERVAL`, `COLLECTOR_HTTP_ADDR`, and source selection. Validate bounds on startup; never log `DATABASE_URL` or secrets.

Slice A/B runtime note: the current no-network source selection is `COLLECTOR_SOURCE=fake` (the default); other source values are rejected. `/status` requires `Authorization: Bearer $COLLECTOR_STATUS_TOKEN`; liveness/readiness remain unauthenticated for probes. Fake outcomes are empty `demo` runs with partial coverage and no snapshot publication.

HTTP surfaces: `/health/live`, `/health/ready` (DB ping and migration compatibility; require current owner lease only when `COLLECTOR_ENABLED=true`), and private `/status` JSON. Add Prometheus exposition only if there is a scraper; DB run history and worker-heartbeat rows remain durable status.

### Slice C — source adapter and persistence

Only after the source gate passes, implement the documented Public Stash feed adapter. Persist feed cursor and a minimal current listing index sufficient to handle updates and removals; calculate target matches from stored `market_targets` using a documented, bounded matcher. Do not claim complete coverage until bootstrap and cursor lag are understood.

Map Go structs to the existing Node strict contracts (`marketTargetSchema`, `marketCollectionRunSchema`, `marketResearchSnapshotSchema`). Reuse existing run statuses: `succeeded`, `empty`, `partial`, `blocked`, `rate_limited`, `failed`, `cancelled`. Store listing asks with source/capture time and coverage; never describe asks as completed trades.

Every run follows this persistence sequence:

1. Verify owner+epoch, then create the `running` run record and claim/advance work atomically.
2. Heartbeat during collection and checkpoint bounded progress.
3. On completion, write the terminal run payload. Publish `market_research_snapshots` only when the coverage contract says it is a complete eligible observation; preserve partial runs without promoting them.
4. Commit publication and terminal run status together. On error, write a sanitized terminal state and leave the previous eligible snapshot intact.

Failure classification:

- 401/403 or explicit challenge: `blocked`; do not retry automatically.
- 429: `rate_limited`; honor `Retry-After` and provider-specific rate headers.
- Other 4xx: permanent request error; no retry.
- Network failures and 5xx: bounded exponential backoff with jitter and an attempt cap.
- Cancellation/shutdown: `cancelled` or `partial` with explicit coverage, never `succeeded`.

## Status and diagnostics

- `market_collection_runs` is the source of truth for per-target run status and failure/coverage counts.
- `market_collection_workers` is the source of truth for process liveness/version/state; stale threshold is 90 seconds with a 30-second heartbeat.
- `/status` and the admin API return instance health plus aggregate run counts over a fixed window; no credentials, cookies, raw response bodies, or raw secret-bearing headers.
- Structured logs include UTC timestamp, instance ID, run ID, target ID, source ID, status, duration, request count, listing counts, coverage, and stable error code. Account names/raw item payloads are not log fields.
- Alert conditions for first rollout: heartbeat age >90s, any `blocked`/`rate_limited`, >3 consecutive transient failures, DB pool saturation, or snapshot lag beyond the configured target interval.

## Contract tests and CI

- Go tests: config bounds, due-work claim/rollback, ownership-epoch takeover and stale-writer rejection, request lease expiry with active-run protection, source cursor replay/deletion, retry classification/jitter bounds, context cancellation, and complete-vs-partial publication.
- Postgres integration: run two workers concurrently against one due target; assert exactly one run/claim and no schedule skip on failed transaction. Simulate worker crash, stale recovery, and re-claim.
- Cross-language compatibility: golden target/run/listing/snapshot/request JSON fixtures; Go encodes them, Node Zod strict schemas parse them, and Node-produced inputs decode in Go. Verify current-input readers preserve target/digest, league/patch, currency, freshness, `inexact`, and `observed`/`demo` rules while excluding partial, stale, demo, and legacy-unknown snapshots from recommendation inputs.
- CI adds pinned Go toolchain, `gofmt -w` check, `go vet ./...`, `go test ./...`, and image build. No credentials or live provider calls in CI.
- Existing Node quality job must remain green; in `MARKET_COLLECTION_RUNNER=go` mode verify API manual runs and `managedCollectionSource` enqueue/wait without invoking Node network adapters.

## Deployment and rollback

1. Apply additive migration and deploy the Node API in `runner=go` mode with Go disabled; verify the API stays healthy and manual collection requests queue without making network requests.
2. Build the Go image on Contabo or CI and deploy a single replica with `COLLECTOR_ENABLED=false`; verify readiness and DB health.
3. Enable the worker with one target and concurrency 1 only after source authorization passes. Confirm the Node UI reads the Go-produced snapshot and its coverage/timestamps correctly.
4. Run through one full interval, restart the worker mid-run, and verify owner-epoch takeover fences the old process, request claims recover only after no active run remains, cursor continuation works, and publication is not duplicated. Review logs/status table and DB latency.
5. Increase target count/concurrency only after source limits and Neon load are measured.
6. Roll back by disabling Go and leaving the Node API in read/enqueue-only mode. Restore `runner=node` only if the previous source is explicitly permitted; otherwise pause collection. Retain additive migration/history.

## Acceptance criteria

- A single Go binary/container starts without Node or Chromium and can run outside Kubernetes using environment configuration.
- Owner epoch fences every write so at most one collector instance can publish across home/VPS/cluster launches; existing Node runs are drained before ownership handoff.
- UI/API controls govern Go schedule and pause state; manual route and recipe managed source are queued for Go, return a durable request ID, and have no Node network fallback.
- Collection reads only enabled due targets, respects global pause/concurrency and per-target interval, and resumes after restart without skipping feed cursor or duplicating data.
- Each request reaches one terminal run state with counts, coverage, timestamps, and stable error code; worker health is visible in DB and private HTTP status.
- Go-written run/snapshot/request JSON passes strict Node schemas. All current recommendation readers require complete coverage in addition to existing matching/freshness rules; demo, partial, stale, and legacy-unknown data remain in history but never replace eligible observed inputs.
- No POESESSID, Cloudflare clearance, undocumented Trade Search call, or challenge automation exists in code/config/logs.
- Live provider collection remains disabled unless GGG source credentials/scope are authorized and feasibility spike passes.

## Risks / unresolved

- Public Stash feed is a global change stream, not a per-target Trade Search endpoint; exact coverage may require a large indexed state and careful removal handling.
- GGG currently says new API application registrations are unavailable; if there is no eligible `service:psapi` client, unattended official collection cannot start.
- Source data may not include enough structured mod detail to match all recipe targets accurately. Any such inference must be marked partial and must not drive a high-confidence craft recommendation.
- User-provided home/VPS deployments may have unstable networks and varying IP/rate policy; the owner epoch prevents stale writes but does not grant source access.
