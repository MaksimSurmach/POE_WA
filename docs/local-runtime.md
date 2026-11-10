# Native macOS runtime

The native installation lives in `~/Library/Application Support/POE Worksmith`.
It contains its own Node binary, compiled release, PostgreSQL database, logs,
and backups. Closing a browser or a Codex chat does not stop server processes.

The old installation put four jobs in `~/Library/LaunchAgents` with
`RunAtLoad`; the app, web, and database also used `KeepAlive`. That made the
application start at login and restart after termination.

The manual installation keeps these plist files in the runtime's
`launchagents/` directory, outside macOS login discovery, with `KeepAlive`
disabled. No database or price history is removed. The old login refresh job
is retained as an inactive file and is not part of manual startup.

From this checkout:

```sh
pnpm local:start
pnpm local:status
pnpm local:stop
```

The installed `Start POE Worksmith.command` and `Stop POE Worksmith.command`
files perform the same operations from Finder, without depending on a checkout.
Startup waits for PostgreSQL before starting the API and web. Stop unloads the
jobs, waits for each process to exit, and stops PostgreSQL last. Repeating start
or stop is safe. A failed shutdown leaves dependent services running and reports
the failure rather than killing them.

After starting, open <http://127.0.0.1:4173/>. Market administration remains at
<http://127.0.0.1:4173/admin/market>. Collection schedules apply only while the
app is running. Prices can expire while it is stopped; start it and allow a
refresh before relying on the estimates.

The control script manages an existing installation; it is not an installer.
It expects the native PostgreSQL 17 installation and loopback port 54326.
Logs and rollback releases remain in the runtime directory. Do not use
`pnpm db:reset` to manage this installation.

## Three-service Compose runtime

The stack runs PostgreSQL 17, the API with the web assets, and the dedicated
collector. The app waits for PostgreSQL, applies migrations, then serves the
UI and the API through the same local port. The collector waits for the app's
database-backed readiness check.

Create the ignored environment file once. Keep it with the database volume
since PostgreSQL uses the password at initialization.

```sh
(
  umask 077
  set -C
  printf 'POSTGRES_PASSWORD=%s\nOPERATOR_DIAGNOSTICS_TOKEN=%s\n' \
    "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" > .env.server
)
docker compose --env-file .env.server -f compose.server.yaml up -d --build --wait
curl -fsS http://127.0.0.1:8080/health/ready
docker compose --env-file .env.server -f compose.server.yaml logs collector
```

Open <http://127.0.0.1:8080/>. Readiness returns JSON with `status: ready`
while the API can query PostgreSQL. `leader acquired` confirms the collector
acquired its advisory lock and subscribed to wake notifications. The API and
PostgreSQL ports are private. Compose `down` preserves both named volumes.

On a fresh database, initialize Trade identity mappings before expecting the
collector to schedule the catalog. Use the existing commands inside the app
container. The import prints the ID to activate.

```sh
docker compose --env-file .env.server -f compose.server.yaml exec app \
  node dist/entrypoints/gameData.js import mappings/poe-trade/3.29.3.3/base-source.json
docker compose --env-file .env.server -f compose.server.yaml exec app \
  node dist/entrypoints/gameData.js activate VERSION_ID
docker compose --env-file .env.server -f compose.server.yaml exec app \
  node dist/entrypoints/tradeMappings.js mappings/poe-trade/3.29.3.3/physical-large-cluster.json
docker compose --env-file .env.server -f compose.server.yaml exec app \
  node dist/entrypoints/tradeMappings.js mappings/poe-trade/3.29.3.3/recipe-catalog.json
```

| Variable                       | Purpose                                                                                                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POSTGRES_PASSWORD`            | Required for the bundled PostgreSQL. Generate a URL-safe password as above.                                                                                                                                                                                                    |
| `DATABASE_URL`                 | Optional API connection URL. Defaults to the bundled PostgreSQL.                                                                                                                                                                                                               |
| `COLLECTOR_DATABASE_URL`       | Direct URL for the collector and migrations. Defaults to the API URL. For external PostgreSQL, use the same database as the API. A transaction pooler cannot preserve the collector's session lock or `LISTEN`. Known Neon `-pooler` endpoints are rejected in collector mode. |
| `APP_ENV`, `DATABASE_SSL_MODE` | Default to `development` and `disable` for the bundled PostgreSQL. For external staging PostgreSQL, use `staging`, `require`, and `sslmode=require` in both URLs.                                                                                                              |
| `PIPELINE`                     | API read path. Defaults to `collector`. The browser fixture runner can select the legacy read path.                                                                                                                                                                        |
| `COLLECTOR_RETENTION_ENABLED`  | Set to `false` during shadow collection. Compose defaults to `false`; other runtimes default to `true`. Keep the same setting for manual recipe sync. Enable after the old worker stops if the collector should take over retention.                                           |
| `OPERATOR_DIAGNOSTICS_TOKEN`   | API bearer token for collector status and Run now through the proxy. Enter it in the operator prompt when using the collector UI.                                                                                                                                              |

Trade is disabled by default. For permitted access, configure the collector
with `MARKET_COLLECTION_SOURCE=trade-compatible`, `POE_TRADE_ACCESS=owner_permitted`,
a `POE_TRADE_USER_AGENT`, and a persistent `POE_TRADE_SESSION_KEY` generated
with `openssl rand -hex 32`. Seed the encrypted session through stdin.

```sh
docker compose --env-file .env.server -f compose.server.yaml exec -T collector \
  node dist/entrypoints/collectTrade.js store-session < /private/path/to/session
```

If browser reauthentication is configured, set `POE_TRADE_USERNAME` and
`POE_TRADE_PASSWORD` in the private environment file. The collector owns a
named volume mounted at `POE_TRADE_BROWSER_PROFILE_DIR`. Treat both volumes
and the environment file as sensitive. `NINJA_USER_AGENT` identifies the
public economy client.

Chromium runs as the unprivileged `node` user and requires host support for
unprivileged user namespaces. Compose uses Playwright's [sandbox seccomp
profile](https://github.com/microsoft/playwright/blob/v1.64.0/utils/docker/seccomp_profile.json)
under the Apache 2.0 license. On hosts where AppArmor restricts user
namespaces, give the collector a specific policy that permits them. On K3s
verify that policy and a collector-specific seccomp profile before enabling
browser reauthentication.
