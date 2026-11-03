**Verdict: I found no remaining P1/P2 packaging blockers.** This was a static read only; I ran no tests, builds, containers or network calls.

## The four previous failures
1. **Compose web stage — fixed.** `compose.yaml:6-8` builds `target: server` and `compose.yaml:35-43` builds `target: web`. Both stages exist in `Dockerfile:28,33`. The web service publishes `127.0.0.1:8080:8080`, which matches nginx's `listen 8080` (`deploy/nginx.conf:2`).
2. **nginx API proxy — fixed.** `deploy/nginx.conf:6-9` has no URI on `proxy_pass`, so `/api/...` reaches `app:3000` with the path unchanged. Host is passed through, and nginx adds no `X-Forwarded-*` by default. `/api/` is matched before the SPA fallback (`deploy/nginx.conf:11-13`).
3. **Migration and bootstrap — fixed.**
   - **Docker:** `README.md:83` runs `dist/migrate.js` before `up`. Compose supplies `DATABASE_URL` (`compose.yaml:15`), `migrate.ts:13` resolves `../drizzle`, and the image has `/app/drizzle` (`Dockerfile:56`). `run` also starts the healthy postgres dependency.
   - **Native:** `README.md:9-10` adds the env-file copy and `pnpm db:setup` (`db:up` then `db:migrate`) before build and start.
4. **Docker admin assumptions — fixed.** `README.md:92-95` now says Docker refresh and admin writes are rejected, which matches the unchanged loopback check (`adminAccess.ts:5`). That check fails on the nginx or gateway source IP even though Host is preserved. Reads stay open because `needsAdminAccess` doesn't cover GETs other than `/api/admin/market/*`. `README.md:96-97` covers the port-3000 conflict when switching to native.

The native dev and preview routes are consistent with the loopback check: `vite.config.ts:6-9` binds both to `127.0.0.1`, and `changeOrigin:false` keeps `Host` as `127.0.0.1:5173/4173`, which the check's Host regex accepts.

## Residual P3 / unverified (not blockers)
- **nginx resolves `app` once at startup** (`deploy/nginx.conf:7`). If `app` isn't resolvable then, nginx fails to start. If `app` is recreated alone, `web` may proxy to a stale IP and return 502 until it restarts. `depends_on: [app]` (`compose.yaml:40-41`) covers the normal `up` path.
- **Vite 8 proxy headers.** I still can't confirm from the repo that the dev and preview proxies send no `x-forwarded-*`. If they do, native writes would be rejected by `adminAccess.ts:8-11`. Your Vite 8 code and docs check covers this; I couldn't verify it without network.
- **Preview inheriting `server.proxy`.** I accept your Vite 8 code and docs check; I can't verify it offline.
- **Mixing the two migration tools on one DB.** Native `pnpm db:migrate` (drizzle-kit) and Docker `dist/migrate.js` (drizzle-orm migrator) can both hit the same DB on `127.0.0.1:54322`. With no custom migrations table in `drizzle.config.ts`, I believe both use the same default journal table. Not verified at runtime.
- **`docker compose run --build`** (`README.md:83`) needs a reasonably recent Compose v2. `compose config` doesn't validate CLI flags.
