# Worksmith Handbook

Worksmith lists manually authored crafting recipes. Each row has one target output and one method. Recipes live in `recipes/<category>/*.json`; the browser has no profile authoring or JSON import. The detail page shows the target, starting base, ordered method, priced materials, and conservative craft-versus-buy comparison.

Use Node 22, pnpm 11 and PostgreSQL 17. For an existing database, back it up and run the forward migrations; never reset it. Migration 0022 adds `method_cost` and retains the historical `variant_costs` payloads, observations and snapshots. Recipe sync updates definitions and soft-disables removed IDs without deleting their history.

```bash
pnpm install --frozen-lockfile
test -f .env.development || cp .env.development.example .env.development
pnpm db:setup
pnpm build
pnpm recipes:validate
pnpm recipes:sync
pnpm start
# In another terminal:
pnpm --filter @poe-worksmith/web dev
```

Open [the local handbook](http://127.0.0.1:5173). To inspect the built frontend
instead, keep `pnpm start` running and use `pnpm --filter @poe-worksmith/web preview`
after `pnpm build`, then open [the local preview](http://127.0.0.1:4173).
Both frontend modes bind to loopback and proxy `/api` to the native API on port
3000, preserving the Host header. Refresh and [market administration](docs/market-administration.md)
use this local workflow.

**Market trends** (`/market`, linked from the header) charts the saved cheapest-ask history per recipe over 24h, 7d, 30d or 1y, with the expected craft cost when it was recorded with that ask. Each refresh adds at most one point per new output snapshot; repeated or carried prices add nothing, and gaps stay visible. The dashboard sorts by percent change or by latest ask within one currency, and shows seller counts, the last source time and a data table. The recipe page embeds the same chart. History is asking prices only, with no sales or volume. Raw points are kept for 30 days, then compacted into daily OHLC rows that are kept for `historyRetentionDays` (default 730); see [price history](docs/database.md#price-history).

Start the separate collector to update recipe prices. The handbook uses current comparable Trade asks with explicit coverage and quote age. Archive history is available on the Trade page.

For a fresh installation, initialize the current Trade identity mappings through the existing import tools before collecting prices:

```bash
pnpm game-data:import apps/server/mappings/poe-trade/3.29.3.3/base-source.json
# Activate the version ID printed by the import command:
pnpm game-data:activate <version-id>
pnpm trade-mappings:import apps/server/mappings/poe-trade/3.29.3.3/physical-large-cluster.json
```

The supplied manifest contains base identity for market mappings only; it is not a complete affix pool. Probabilities are manually checked against the archived Craft of Exile configurations for patch 3.29.3.3. Their rounded display values produce indicative estimates. Unsupported leagues or missing evidence leave expected total and ROI unestimated. See [recipe schema](docs/recipe-schema.md) and [checked calculator evidence](docs/evidence/worksmith-2026-11-02/).

Automatic Trade website access is disabled by default. Configure only access you are permitted to use, using the existing `MARKET_COLLECTION_SOURCE=trade-compatible`, `POE_TRADE_ACCESS=owner_permitted` and `POE_TRADE_USER_AGENT` settings. Session credentials remain server-side. A challenge/403 pauses collection; do not bypass protection. [Provider setup](docs/market-engine-beta.md) documents the connection boundary. Public material economy data uses `NINJA_USER_AGENT` (or the configured application user agent) and the existing documented poe.ninja client.

## Backend runtime

Start the API with `pnpm start:api` after building. The API exposes liveness at
`/health/live` and PostgreSQL readiness at `/health/ready` on `127.0.0.1:3000`.
Start collection separately with `pnpm --filter @poe-worksmith/server start:collector`
or install the dedicated Home Assistant add-on.

The collector reads persisted schedules and waits for a PostgreSQL notification
or the next due job. One PostgreSQL session holds leadership. Run now records a
request before waking that session. The homepage shows its progress. Quote age,
collection pause, and warning age use the saved operator settings.

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
Authentication and schema errors appear in the collector status. Quotes beyond
the configured age or without sufficient evidence withhold profit and ROI.

Build and run the backend and built frontend in Docker after applying forward
migrations. For an existing database, back it up first; the migration command
starts PostgreSQL and preserves its data:

```bash
docker compose --profile app run --build --rm app node dist/migrate.js
docker compose --profile app up --build
```

Open [the Docker handbook](http://127.0.0.1:8080). The web service serves the built
assets and proxies public `/api` reads to `app:3000`; the API is also bound to
`127.0.0.1:3000` on the host. Migrations are an explicit prerequisite, not an
automatic container startup operation.
If `app` is recreated separately, run `docker compose --profile app restart web`
to refresh nginx's upstream address.

Run now, collector status, settings, Factory and craft-model editing require no
application token. Bind the web/API to loopback or restrict the reverse proxy to
the private LAN/VPN. Do not expose this deployment on a public ingress.
Stop `app` and `web` with `docker compose --profile app stop app web` before
starting the native API on the same port; PostgreSQL and its data remain in place.

The server image starts the API by default. Start a separate container with
`node dist/entrypoints/collector.js` for collection. The three-service
`compose.server.yaml` keeps the web/API, collector, and PostgreSQL separate.

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
2. Copy `.env.staging.example` to `.env.staging` and replace `DATABASE_URL`
   with the connection string from the dashboard's **Connect** action; keep
   `sslmode=require` on the URL.
3. Build and check it without changing application code:

   ```bash
   pnpm --filter @poe-worksmith/server build
   node --env-file=.env.staging apps/server/dist/checkDatabase.js
   ```

4. Apply migrations with the staging configuration:

   ```bash
   node --env-file=.env.staging apps/server/dist/migrate.js
   ```

For a persistent IPv6-capable backend, prefer the direct endpoint
`db.<project-ref>.supabase.co:5432`. On an IPv4-only host, use the shared
Supavisor session pooler on port `5432`. Reserve transaction mode on port
`6543` for short-lived/serverless clients; it does not support prepared
statements. Keep migrations and administrative commands on a direct or session
connection.

All `.env*` files are ignored except the placeholder `*.example` files. Never
commit database passwords or generated Supabase secrets.
