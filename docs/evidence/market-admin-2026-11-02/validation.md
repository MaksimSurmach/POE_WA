# Market admin acceptance — 2026-11-02

Base: draft PR #26, `3f2663a3cb3b14a73e8a8fc9d4fb2615478d0faf`.
This work is a stacked change; no merge or production deployment is authorized.

## Runtime and browser evidence

Ran the real API/worker on a separate development database using Node 22.23.4,
pnpm 11.8.0 and PostgreSQL 17.11. The existing frontend ran at loopback with a
same-origin Vite proxy. Existing services on ports 3000/5173 were preserved;
owned smoke services used 3017/5179.

- Opened `/admin/market` in Chromium at 1440px and 390px. No horizontal overflow
  at 390px. The final browser error/warning log was empty.
- Disabled automatic recipe refresh and scheduled observations through the UI.
  Verified that the pg-boss catalog schedule was removed.
- Injected one scheduler job into the existing queue to exercise disabled
  admission: recorded `skipped`, zero source queries.
- Selected economy/material-only refresh in the UI. The permitted public
  poe.ninja source completed four categories and persisted four snapshots.
- Changed the timeout to 12 seconds and raw retention to 96 hours through the UI.
  Configured/effective settings agreed. Dynamic timeout and retention application
  also have regression tests using the actual provider client/repositories.
- Exercised pause/resume; manual Run Now was unavailable while paused.
- Restarted the actual API/worker. Settings version 4, automatic-off state and
  the edited timeout/retention survived. Compared recipe counts and every saved
  economy snapshot's ID, payload hash and capture time before/after: unchanged.

[Live receipt](live-smoke.json) · [Restart receipt](restart-smoke.json) ·
[Desktop screenshot](desktop.png) · [Mobile screenshot](mobile.png)

The live source was poe.ninja. Trade collection was unconfigured and blocked;
no challenge or access control was bypassed. Provider 401/403/429 and cooldown
behavior use deterministic regression evidence, not induced live rate limits.

## Automated validation

Local runs use Node 22 / pnpm 11 / an isolated PostgreSQL 17 cluster. Fresh
migration validation also applies the consolidated migration to an empty
database.

- 401 unit tests: 64 domain, 10 contracts, 290 server, 37 web.
- 108 PostgreSQL integration tests; 7 explicit backend E2E tests.
- 7 provider contract tests (also included in the unit suite).
- Lint, typecheck, production build and migration consistency passed.
- Fresh empty-database migration passed, including the run-progress column.
- Server/web container builds are checked by PR CI; Docker was unavailable
  locally. CI results are recorded in the PR.

Coverage includes strict settings validation, concurrent optimistic writes,
transactional enqueue rollback, cross-process deduplication, protected legacy
writes, scheduled admission, cancellation, retention, pool/repository recreation,
orphan/expired runs, selected-recipe publication and unchanged carried prices.
The publication/cancellation race uses two real PostgreSQL connections and checks
that publication waits on the cancellation transaction before refusing to publish.

Independent review evidence is recorded in [the review receipt](review.md).

Limits: physical mobile, Safari and screen-reader testing were not performed.
Remote admin authentication was not established; this is a direct-loopback admin
boundary. No production data was changed. Long-running research observations
retain the existing 30-minute abandoned-heartbeat grace; catalog job recovery
uses pg-boss heartbeat and explicit cycle reconciliation.
