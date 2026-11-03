Static review only. I ran nothing: no tests, builds, containers or network calls.

## Two routes

**Native route (`pnpm start` + Vite dev).** Reading the code, this route should work.
- `pnpm start` loads `.env.development` (`apps/server/package.json:20`), which binds the server to `APP_HOST=127.0.0.1` (`.env.development.example:3`).
- Vite proxies `/api` to `127.0.0.1:3000` with `changeOrigin:false` (`apps/web/vite.config.ts:7`). The server therefore sees `request.ip=127.0.0.1` and `Host: localhost:5173`, and `Origin` matches `Host`. `isLocalAdmin` passes (`apps/server/src/adminAccess.ts:5-27`).
- The client uses relative paths: `baseUrl=''` (`apps/web/src/apiClient.ts:33`). The proxy makes them same-origin.
- Not verified: whether Vite's proxy adds `x-forwarded-*` headers. I believe it doesn't by default, but I'm not 99% sure. If it does, `adminAccess.ts:8-11` rejects every admin and refresh write in dev.

**Production image route (`docker compose --profile app up --build`).** This route is broken; blockers 1–4 below.

## Blockers

**1. The Docker app serves no frontend.**
- `compose.yaml:6` uses `build: .` with no target, so it builds the last stage, `server` (`Dockerfile:33`).
- The built web files are copied only into the `web` stage (`Dockerfile:28-31`), and no compose service builds that stage.
- Fastify only registers `/api/*`, `/health/*` and `/metrics`. Anything else hits `ROUTE_NOT_FOUND` (`apps/server/src/api.ts:190`).
- Fix: add a compose service with `build: {context: ., target: web}`, ports `127.0.0.1:8080:8080`, `depends_on: [app]`.

**2. nginx has no same-origin `/api` route.**
- `deploy/nginx.conf:6-8` sends `/api/*` through `try_files` to `index.html`.
- `apiClient.ts:47` then calls `response.json()` on that HTML and throws.
- Fix: copy the Vite proxy pattern into nginx: `location /api/ { proxy_pass http://app:3000; }`.

**3. Refresh and admin can never pass the loopback check in Docker.**
- Requests reach the container from the Docker gateway or NAT address, not `127.0.0.1`, so `adminAccess.ts:5` fails.
- Going through nginx (blocker 2) also fails: nginx's own IP, `Host: app:3000`, and any `X-Forwarded-*` headers each trip `adminAccess.ts:5`, `:8-11` or `:14`.
- Result: `POST /api/refresh` and all `/api/admin/market/*` return `OPERATOR_AUTH_REQUIRED` (`api.ts:102-103`). This contradicts `README.md:18` ("Refresh Prices") together with `:70-74` ("same application").
- Fix (no auth design): document the image as read-only for the UI, and trigger refresh from inside the container, where it is genuinely loopback. For example: `docker compose exec app wget -qO- --post-data='' http://127.0.0.1:3000/api/refresh`. By the code, busybox wget sends no Origin, and a Host of `127.0.0.1:3000` matches the regex. I haven't run this.

**4. Docker never migrates the schema.**
- The container runs `dist/entrypoints/all.js` (`Dockerfile:64`), which calls `runProcess` (`process.ts:67`). Nothing there migrates; only pg-boss's own schema is migrated (`jobs.ts:47`).
- On a fresh `postgres-dev-data` volume, the first query (`admin.init()`, `process.ts:105`) inserts into `market_admin_settings` (`marketAdmin.ts:112-113`). That table doesn't exist yet, so startup fails.
- `README.md:72-74` has no migrate step.
- Fix: add one README step before `up`: `docker compose --profile app run --rm app node dist/migrate.js`. `dist/migrate.js` resolves `../drizzle` (`migrate.ts:13`), and that folder is copied to `/app/drizzle` (`Dockerfile:56`).
- Alternative: run `pnpm db:migrate` from the host. Its default URL is the same DB on `127.0.0.1:54322` (`apps/server/drizzle.config.ts:8`).

**5. The native quick-start block is missing its prerequisite steps.**
- `README.md:7-16` starts at `pnpm install`. It never says to `cp .env.development.example .env.development` or run `pnpm db:up`; those only appear later, at `README.md:84-88`.
- Without the env file, `--env-file-if-exists` silently loads nothing, and `pnpm start` fails because `DATABASE_URL` is required (`apps/server/src/config.ts:33-39`).
- `pnpm db:migrate` still works without the file because it has a hardcoded URL (`apps/server/drizzle.config.ts:8`), which hides the problem until start.
- Fix: put those two lines at the top of the block at `README.md:8`.

The README's import and activate commands (`README.md:20-27`) are not blockers. With `.env.development` present, they reach the Compose Postgres through `127.0.0.1:54322`.
