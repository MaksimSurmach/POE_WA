# POE Worksmith Automator

## Crafter market workbench

The primary UI now investigates **what to craft**: build-linked target profiles,
observations of comparable asking prices, source provenance and snapshot history.
The previous recipe catalogue remains at `/catalog`.

Requirements remain Node 22 and pnpm 11. After installing dependencies:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start:market
```

In another terminal, start the UI:

```bash
pnpm --filter @poe-worksmith/web dev
```

Vite proxies `/api` to the API on `127.0.0.1:3000`. `start:market` starts only the
API; it does not launch the old trade worker. With no PostgreSQL configuration,
the UI explicitly shows unavailable storage and offers a clearly labelled,
local-only demonstration. It never pretends that changes were persisted.

To save targets and observations, configure the local database using the
instructions below and apply all migrations. The new research tables are
additive and are not subject to the old recipe retention policy. The Sources
panel records economy collection attempts, including provider errors and cache
reuse. Open the main page, create a target with its league/patch and source
links, and import a JSON snapshot. See [observation format](docs/market-observation-format.md),
[data source capabilities](docs/market-data-sources.md), and the
[M1 implementation plan](docs/plans/2026-10-29-crafter-market-intelligence.md).

This is the first delivery within M1. Automated rare-listing access, PoB parsing,
structured mod matching and a crafting-profit model are not complete. Asking
prices, base estimates and completed transactions are different evidence types.

### Public economy collection

Set `NINJA_USER_AGENT` in your local environment file to identify your application
and a real contact, for example:

```dotenv
NINJA_USER_AGENT="POEWorksmith/0.1 (contact: https://github.com/MaksimSurmach/POE_WA/issues)"
```

After applying migrations, restart `start:market`, open **Источники**, fetch the
league list, select a category and collect a snapshot. No game password or API
key is required for this public economy source. PostgreSQL must be ready before
collection starts. The UI previews up to 200 rows; the full response is retained
in the economy snapshot table. A cache hit or `304` reuses the same observation.
The Sources panel keeps a separate journal of each collection attempt.

Raw economy payloads are retained for 90 days and snapshot summaries for 730
days by default. Set `MARKET_ECONOMY_RAW_RETENTION_DAYS` and
`MARKET_ECONOMY_SUMMARY_RETENTION_DAYS` to positive day counts to change the
policy. Expired raw payloads remain visible as summaries but cannot be opened;
expired summaries are removed when the Sources overview loads. Seed the reviewed guide-based profiles
after migrations with `pnpm market:seed-library`; the command is safe to rerun.

The API is intended for one trusted operator on loopback or behind a private
access boundary. It is not yet a public multi-user service.

See [validation evidence and remaining gates](docs/market-validation.md).

## Backend runtime

The server has dedicated API, worker, and combined entrypoints. After building,
start one mode with `pnpm start:api`, `pnpm start:worker`, or `pnpm start`.
The default combined mode exposes liveness at `/health/live` and database
readiness at `/health/ready` on `127.0.0.1:3000`.

The worker owns PostgreSQL-backed full-refresh and retention schedules. The
refresh runs every four hours by default, uses an exclusive pg-boss queue across
all worker instances, and reuses the queue job ID as the refresh-cycle ID. The
cleanup runs daily and removes raw snapshots after 72 hours, observations after
14 days, and old completed jobs in bounded batches while preserving active and
published cycles. `SIGINT` and `SIGTERM` stop HTTP intake, wait for active jobs
up to `SHUTDOWN_TIMEOUT_MS`, then close the shared PostgreSQL pool.

`GET /api/refresh` returns the current and published cycles with query/recipe
totals, completed and failed counts, and all progress timestamps. Tests can run
the production scheduling path deterministically through
`CatalogRefreshScheduler.triggerRefresh()`; pg-boss applies the same singleton
protection as cron delivery.

Every PoE Trade request passes through a shared PostgreSQL rate-limit
controller. It parses GGG policy/rule windows and `Retry-After`, merges endpoints
that report the same policy, and applies conservative one-request-per-second
pacing when headers are absent or malformed. The diagnostics endpoint
`GET /api/diagnostics/rate-limits` exposes current windows, mapped endpoints,
delay, status, and the effective wait deadline. Configure `POE_USER_AGENT` with
GGG's required `OAuth client/version (contact: contact)` format.

Provider calls time out after `POE_REQUEST_TIMEOUT_MS` and retry transient
timeouts, 429s, and 5xx responses with bounded exponential backoff and jitter.
Repeated failures open a PostgreSQL-backed circuit per provider endpoint, so
all workers stop outbound calls during cooldown and admit one half-open probe.
Authentication and schema errors are terminal. A failed refresh never replaces
the last published catalog; eligible recipes can use their prior evaluations as
explicitly stale fallback data.

Build and run the same application in Docker with environment configuration:

```bash
docker compose --profile app up --build
```

The image defaults to combined mode. Override its command with
`node dist/entrypoints/api.js` or `node dist/entrypoints/worker.js` for split
deployments.

## Local PostgreSQL

Requirements: Node.js 22, pnpm 11, and Docker Compose.

```bash
cp .env.development.example .env.development
pnpm db:up
pnpm db:migrate
pnpm db:check
```

The development service binds only to `127.0.0.1:54322`. Its checked-in
credentials are local-only and must never be reused outside this Compose stack.

Use the isolated, disposable test database on port `54324`:

```bash
cp .env.test.example .env.test
pnpm db:test:up
set -a && source .env.test && set +a
pnpm test:integration
```

Stop both services with `pnpm db:down`. Development data uses a named volume;
test data uses a temporary filesystem and is discarded with the container.

`pnpm db:setup` creates the local database and applies every migration from an
empty volume. Migrations are forward-only in shared environments: fix a bad
migration with a new corrective migration. During local development only,
`pnpm db:reset` removes the local database volume, recreates PostgreSQL, and
reapplies the full migration history. This command deletes local data.

## Supabase staging

1. Create a Free project in the Supabase dashboard.
2. Copy `.env.staging.example` to `.env.staging` and replace the placeholders
   with the connection string shown by the dashboard's **Connect** action.
3. Build and check it without changing application code:

   ```bash
   pnpm --filter @poe-worksmith/server build
   node --env-file=.env.staging apps/server/dist/checkDatabase.js
   ```

For a persistent IPv6-capable backend, prefer the direct endpoint
`db.<project-ref>.supabase.co:5432`. On an IPv4-only host, use the shared
Supavisor session pooler on port `5432`. Reserve transaction mode on port
`6543` for short-lived/serverless clients; it does not support prepared
statements. Keep migrations and administrative commands on a direct or session
connection.

All `.env*` files are ignored except the placeholder `*.example` files. Never
commit database passwords or generated Supabase secrets.
