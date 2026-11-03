# Working release acceptance — 2026-11-03

This run uses a private local staging environment: Node 22.23.4, pnpm 11.8.0,
PostgreSQL 17.11 with verified TLS and the built frontend at
`http://127.0.0.1:4173`. It is not a remote production deployment.

PR [#26](https://github.com/MaksimSurmach/POE_WA/pull/26) merged as `fe49a5b7`.
PR [#27](https://github.com/MaksimSurmach/POE_WA/pull/27) merged as `36305556`
after [its final CI](https://github.com/MaksimSurmach/POE_WA/actions/runs/41551801804)
passed, including both container builds. Independent agent reviews are recorded;
they are not formal GitHub approvals.

## Data preservation and recovery

| Check                     | Observed result                                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup and upgrade        | Read-only backup of the existing development database, restored into isolated PostgreSQL 17; migrations 0022 and 0023 applied. All 23 existing tables retained equal row counts and row hashes. |
| Actual API/worker restart | 28 raw snapshots, 28 aggregates, 20 evaluations and five economy snapshots retained identical hashes; settings version 4 survived unchanged.                                                    |
| Durable queue             | A materials refresh accepted with no healthy worker stayed queued, then completed 4/4 queries after the worker restarted.                                                                       |
| Actual database outage    | Readiness changed to 503 while the isolated PostgreSQL instance was stopped, then recovered to 200 with a healthy worker without restarting the application.                                    |
| Access boundary           | Foreign Host, Origin, forwarding-header and cross-site requests rejected with 401; invalid settings returned 400 and stale versions returned 409 without changing the saved version.            |
| TLS                       | Trusted local CA connected with `rejectUnauthorized: true`; an untrusted connection failed.                                                                                                     |
| Natural expiry            | Old cost, ask, profit and ROI became unavailable at their original immutable expiry; increasing maximum age did not retimestamp them.                                                           |

Receipts: `migration-preservation.json`, `restart-queue.json`,
`database-outage.json`, `admin-access-smoke.json`, `tls-smoke.json` and
`natural-expiry.json`. The private backup and original raw item payloads remain
local; no seller identities or credentials are included here.

## Actual permitted market observations

The current league was independently resolved as Allflame through the configured
Trade and poe.ninja clients. Collection used the real search/fetch and immutable
raw-store path, with provider rate limits; no session credential, replay,
synthetic fixture or manual market import supplied these prices.

- `initial-live-e2e.json`: 7/7 queries, both original recipes published. Rare
  cluster expected cost 1248.5647 chaos versus an 820.2 chaos ask: an indicative
  loss. The empty magic search has no sale price or ROI.
- `zeal-live-e2e.json`: the new fractured-suppression recipe completed 3/3
  queries. Fourteen starting-base offers and one exact finished-item offer were
  observed. The high modeled spread is low confidence: one seller's ask does
  not establish a sale price or liquidity.
- Both baseline economic observations above used minimum-level acquisition and are superseded for cost acceptance by the exact-level gate.
- The broad-base full cycle was intentionally cancelled at 29/46 completed queries; its 57 raw snapshots and previous publication stayed unchanged.
- `full-exact-live-e2e.json`: final exact-level full cycle succeeded: 46/46 queries and 15/15 recipes, with zero failures. It collected 25 queries on their first attempt and reused 21 compatible target/material observations with their original dates. The catalog exposed 12 expected costs, 11 comparable asking prices and nine modeled spreads.
- `bone-refinement-live-e2e.json`: the subsequent scoped gate checks the final Bone Helmet implicit acquisition guard; it supersedes only that recipe and verifies the other 14 evaluations stay unchanged.

Handbook collection now fetches at most the first 20 price-sorted IDs. Full
returned IDs and search evidence are retained. A separate proof marks a complete
sorted sample, never a complete provider page; incomplete/cancelled samples do
not produce prices. Sampled output or starting-base prices force low confidence.
The UI distinguishes fetched offers from verified sellers and labels thin
markets and indicative profit. Research collection retains its 1000-detail cap.

## Catalog and checks

All 15 recipes resolve starting-base, target and non-identity material mappings
against the actual active staging game-data version. Initial sync created 13,
kept the original two unchanged, and a second dry run reported all 15 unchanged.
The source Sheet's 16 candidates and all original MAX-1288 candidates remain in
the respective source/research evidence bundles.

Twelve recipes have current calculator models, including ten newly checked procedures; three complex procedures remain unestimated. All starting-base links now require the exact model item level, while finished-item queries retain minimum levels. A per-recipe scope update invalidated the old broad-base EV; the original 20 historical evaluations retained identical hashes.

Calculator verification is scoped to the documented current item, stopping
conditions, paid retries and finish. It does not prove in-game execution or
profitability. Unmodeled full procedures retain null expected cost and ROI.

Final source checks passed: 474 unit/UI tests, 119 real PostgreSQL integration
tests, eight backend E2E tests and seven provider-contract checks (the latter
overlap unit coverage). Build, lint, typecheck and migration consistency passed.
These include retry/cancellation/lock-order regressions, persisted provider
cooldowns and separate reuse/usable-age behavior.

A clean Chromium session rendered all 15 recipes at 1200px and 390px with no
horizontal overflow, zero console errors/warnings, working search/tag filters,
and an accessible item tooltip. The real purchase link requires item level
85 exactly and fractured suppression >=14. Receipts and screenshots are in
`browser-acceptance.json` and the adjacent PNG files.

Fresh installations use hourly refresh, 30-minute cache reuse and a two-hour
usable quote window. Existing saved settings are retained. This staging run uses
a two-hour usable quote window. After the live gates, hourly automatic and
scheduled collection are enabled; staging reuses snapshots for five minutes so
new scheduled runs reacquire market observations. Source timestamps and expiry
remain immutable. The catalog continues to show the prior usable publication
while the next refresh runs. The final scoped run encountered a temporary
poe.ninja cooldown: existing usable economy quotes were retained, and the admin
source indicator reports the failed attempt. The cleanup schedule remains disabled for this
evidence environment.

## Limits

Asking prices are not completed sales; samples are not population demand. No
in-game crafting, purchases or selling was performed. Local Docker runtime,
physical mobile, Safari and real screen-reader speech remain untested. The local
TLS acceptance CA expires after seven days; this environment has no reboot
autostart. Containerized admin writes remain blocked by the direct-loopback
policy. Full-repository formatting also reports older drift and byte-preserved
source captures; changed application code/configuration is checked separately.

CI for the final code head `31d0971` passed, including server and web container
builds: [quality run](https://github.com/MaksimSurmach/POE_WA/actions/runs/41561037081).
PR [#28](https://github.com/MaksimSurmach/POE_WA/pull/28) contains the catalog,
pricing guards and these acceptance receipts; the final documentation commit
receives its own CI before merge.
