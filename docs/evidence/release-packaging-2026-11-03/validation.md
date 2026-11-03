# Built frontend and local operation — 2026-11-03

Fixed the documented Docker path: the `app` profile now builds the existing
`server` and `web` targets, exposes the built frontend on `127.0.0.1:8080`, and
nginx proxies `/api/` to the existing `app:3000` API without rewriting its path
or Host header. Previously the profile exposed only the API, and the standalone
web image returned its SPA HTML for API requests.

Native dev and built preview bind to loopback. Vite preview inherits the dev API
proxy; this was verified in current official documentation and installed Vite
8.1.5's `preview?.proxy ?? server.proxy` configuration. The preview package script
serves the existing build rather than introducing another application server.

README setup now creates the missing environment file only if absent, starts
the local database and applies forward migrations. The Docker instructions run
the existing `dist/migrate.js` command before application startup. Neither path
resets a database. Existing Trade identity initialization and provider permission
requirements remain separate prerequisites.

Operator protection is unchanged. Docker gateway/container addresses do not
qualify as direct loopback, so Docker refresh/admin requests remain rejected.
The documented native API plus local dev/preview is the working operator path.
Proxy headers do not grant access, and no remote authentication or gateway
allowlist was added. The README also covers the shared port and restarting nginx
after the app container is recreated separately.

Checks on Node 22.23.4 / pnpm 11.8.0:

- Frontend dependencies and production build passed with Vite 8.1.5.
- Frontend typecheck, scoped ESLint, formatting and diff whitespace checks passed.
- `docker compose --profile app config --format json` parsed successfully;
  assertions checked both build targets, web's app dependency and private ports.
  Installed Compose 5.5.1 exposes `run --build` in its CLI help.
- Actual built-preview HTTP smoke on `127.0.0.1:4174`, against the native API on
  port 3000: nine checks passed for HTML, JavaScript asset, SPA admin route,
  catalog, refresh progress, league discovery and admin reads. Matching
  same-origin admin access returned 200; cross-origin and forged forwarded
  headers returned 401 `OPERATOR_AUTH_REQUIRED`. No mutation request was sent.
- An actual independent Claude Code source audit identified the packaging
  failures; re-review found no remaining P1/P2 packaging blockers. Original
  results and session/model receipts are retained here. The reviewer did not
  run runtime checks; its uncertainty about native proxy headers was resolved
  by the actual successful admin-read smoke.

`native-preview-smoke.json` records the actual HTTP results. The temporary
preview process was stopped after checking; the root agent owns final integrated
browser acceptance and runtime lifecycle testing.

Docker image startup, nginx runtime routing and the container migration command
were not executed locally because the Docker daemon is unavailable. CI image
builds and deployment smoke must establish those container gates. This patch
does not establish remote operator access or a production deployment.
