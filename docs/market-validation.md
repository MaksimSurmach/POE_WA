# Market workbench validation — 2026-10-29

## Completed

- Frozen-lockfile install with the repository's exact dependency versions.
- Full workspace unit tests; server subset reports 153 tests in 37 files,
  frontend reports 23 tests in 8 files.
- TypeScript checks, lint and production build.
- Drizzle migration consistency checks, including additive migrations 0014/0015.
- API-only compiled runtime starts without a database or game credentials;
  liveness succeeds and market endpoints explicitly report unavailable storage.
- Actual public league discovery returned HTTP 200 from poe.ninja.
- The compiled `NinjaEconomyClient` fetched a real Allflame / BaseType overview:
  9,344 normalized rows, `stash-estimate` basis. Capture time recorded by the
  connector: `2026-10-29T00:24:24.266Z`.
- Real response SHA-256:
  `9af1dd178796b99a37b4d6e57a32174b296912cde6cf0543330d5a7e72da6491`.

The live response was a connector smoke test, not a persisted PostgreSQL snapshot
or a recommendation about any item. High or sparse quotes are not evidence of
profitable crafting.

## Earlier environment record

GitHub Actions [run 40830702147](https://github.com/MaksimSurmach/POE_WA/actions/runs/40830702147)
validated implementation commit `64fa15636200e225a7065cb2e9c9adf690b3cb29`
on the repository's Node 22 / pnpm 11.8 runtime with PostgreSQL 17. Migration
application, all repository integration tests (including both new market
repositories), the existing backend end-to-end suite, and the production build
passed. The market integration tests verify concurrent import deduplication,
raw-payload preservation, separate later observations and reading through a new
repository instance. They do not perform a full API-process restart or a browser
workflow.

The local runtime was Node 24.22.1 / pnpm 11.25.0; the repository's supported
runtime remains Node 22 / package manager pnpm 11.8.0. Dependencies were not
downgraded or replaced in manifests. Behind this executor's configured proxy,
the Node smoke test used `NODE_USE_ENV_PROXY=1`; direct Node fetch could not
reach the network.

PostgreSQL/Docker are unavailable locally. The new repository integration tests
are guarded to run only against the isolated `poe_worksmith_test` database and
have now passed in CI. A full API-process restart followed by the complete
market UI workflow remains an acceptance gate.

The local browser plugin had no originating browser context. The separate cloud
browser could not access the development server; a browser policy gate blocked
subsequent observation of its error page. No workaround was attempted. Visual,
keyboard and mobile end-to-end inspection are not claimed as complete.

No Path of Exile password, session cookie or user account token was used. No
internal Trade Search or Ninja builds endpoint was called. Existing databases
were not migrated or reset in that earlier run.

## Verification this turn — 2026-10-29 (latest)

- Started Docker Desktop and PostgreSQL 17.11. Applied migrations through 0017
  to the local dev database and isolated test database.
- Through the browser UI, saved a real poe.ninja Allflame / BaseType snapshot
  in PostgreSQL: 9,334 normalized rows, `stash-estimate` basis, captured at
  `2026-10-29T07:35:51.467Z`, id
  `11a7536e-24f8-4ae4-baf4-a35f485a678b`. The attempt journal links it as a
  successful `fetched` collection. API restart retained it. This is a base
  estimate, not a rare-item price.
- Seeded the reviewed guide library: ten profiles across five builds. Sources
  include publication/update dates, check date, patch 3.29 and an explicit
  note that guide recommendations do not establish demand or price. Rerunning
  the seed command is digest-idempotent.
- Added configurable economy retention: raw payload 90 days and summary 730
  days by default; summaries remain visible after raw payload expiry.
- Browser confirmed saved economy summary, collection attempt and seeded guide
  links/notes. At 390px, viewport, document and body widths all measured 390px.
  Screenshots: [economy desktop](../output/playwright/market-economy-desktop.png),
  [guide library desktop](../output/playwright/market-library-desktop.png),
  [guide library mobile](../output/playwright/market-library-mobile.png),
  [economy mobile](../output/playwright/market-economy-mobile.png),
  [main desktop](../output/playwright/market-main-desktop.png),
  [main mobile](../output/playwright/market-main-mobile.png).
- `pnpm build`, `pnpm test` (254 tests), `pnpm lint`, migration consistency,
  and isolated PostgreSQL integration (37 tests) passed on local Node 24.17.0,
  outside the repository's Node 22 engine range. A fresh CI run on the pushed
  head is still required. An earlier integration attempt exposed that the test
  DB lacked migration 0017; after applying it, all 37 tests passed.
- The prior smoke demo import was removed after confirming PostgreSQL
  idempotency and API-restart persistence. No rare-item price was fabricated.

## Remaining acceptance gates

- Complete browser checks for real rare-item import/history, source failure,
  stale/minimum samples, unavailable storage, and updated desktop/narrow UI.
- Run final CI on the pushed head, review outstanding PR comments, and sync
  Linear to the verified delivery.
