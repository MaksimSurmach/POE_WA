# Catalog and local runtime acceptance — 2026-11-04

Installed code: `9523f9d0ec062a9fcafa396afafb045529db473c`.
PR: <https://github.com/MaksimSurmach/POE_WA/pull/30> (not merged).
CI: <https://github.com/MaksimSurmach/POE_WA/actions/runs/41824859237> — passed,
including server and web Docker builds.

## Findings and fixes

- The installed release still calculated 3531.587355% ROI for Fossilised Shield
  from one seller. It now keeps the ask visible and withholds profit/ROI.
  Independent seller deduplication, currency conversion, input expiry, and
  expected base/material costs were reviewed. Missing or malformed legacy seller
  evidence also withholds profit.
- The catalog used cards with repeated labels. It now has table headers for
  name, item class, expected cost, cheapest ask, profit, ROI, and market evidence.
  Each header sorts in both directions; missing values remain last, and monetary
  sorting groups currencies instead of comparing nominal chaos/divine amounts.
  Filters cover name, class, tag, minimum profit with currency, and minimum ROI.
  URL parameters preserve selection through recipe navigation and browser Back.
- All 26 recipes now have artwork. Eleven missing base icons were restored from
  artwork paths in stored Trade observations and checked against the official
  CDN. Generic artwork omits the listing-specific fractured/influence overlays.
- Stored valuation source time/count remains visible when the latest raw snapshot
  differs or is absent. The page re-reads server freshness every 30 seconds while
  visible and on focus, hides old values on read failure, and recovers on success.
- Persistent market history and its responsive views were integrated from the
  previously prepared integrity branch. This is ask history; sales volume is
  unknown. No historical asks are presented as completed sales.
- Four macOS LaunchAgents caused login startup; three also had KeepAlive. Their
  plist files now live outside `~/Library/LaunchAgents`, with KeepAlive disabled.
  Finder start/stop commands and `pnpm local:start|stop|status` control the existing
  native installation. Start verifies PostgreSQL/API/web; stop unloads app/web
  before PostgreSQL. Collection settings were restored, version 14.

## Verification

- 567 Vitest tests: 64 domain, 13 contracts, 405 server, 85 web; native service
  control self-check also passed (568 checks including that self-check).
- 140 PostgreSQL integration tests, 8 backend E2E tests, 7 provider contract tests.
  These suites overlap; their counts are not an additional grand total.
- Build, lint, typecheck, formatting, migration metadata, 26-recipe validation,
  and GitHub CI passed. Two independent code-review passes found no actionable
  P1/P2; the final startup-readiness delta was reviewed separately.
- Browser: header ordering, combined class/profit/ROI filters, Back navigation,
  empty results/reset, stale/offline recovery, all 26 loaded images, tooltip
  keyboard dismissal, history ranges. Widths 320/390/768/1440 had no page overflow.
  The table intentionally scrolls horizontally on narrow screens.
- Migration 0024 was rehearsed on a restored copy, then applied to the stopped
  native app's database. All 27 existing public tables retained row counts and
  full-row digests in both runs; only two history tables were added. See
  `migration-preservation.json`.
- The new installed evaluator reprocessed all 26 recipes using existing market
  snapshots, without new Trade collection: 11 success, 15 partial, no failed
  evaluations. All 1178 raw snapshots and 26 recipes remained. Source observation
  timestamps were retained. See `revaluation.json`.
- Every public profit and ROI was checked against its displayed ask and cost;
  fewer than two sellers never produced either. Installed API/web health passed;
  manual stop/start/stop passed. Final native ports 3000/4173/54326 are closed.

## Limits and next league

Two asking sellers do not establish actual sale probability or realized profit.
The remaining partial results explicitly lack enough cost, market, or model
evidence. Three authored models remain unverified: `tr-grizzly-aoe-helmet`,
`lacerate-shaper-recovery-shield`, and `minion-leviathan-fear-gloves`.
Do not assign them numerical profitability until their crafting procedures and
probabilities are checked. Existing verification applies to the recorded patch
and league; recheck bases/modifiers/procedures and collect new-league prices
before treating the next league as supported.

Physical devices, screen-reader speech, reboot/logout, and in-game crafting were
not tested. The artwork remains dependent on the official CDN. The app collects
only while explicitly running; stopped prices naturally expire.

## Local recovery assets

Runtime: `~/Library/Application Support/POE Worksmith`.
New release: `releases/preleague-20261104`; previous release retained as
`releases/craft-profit-20261103-final`. Database backups:
`backups/before-preleague-20261104.dump` and
`backups/preleague-stopped-20261104.dump`. Original launch settings, collection
settings, and operations guide: `backups/preleague-config-20261104/`.

The source checkout is `codex/preleague-quality`; unrelated existing worktrees
and their uncommitted edits were preserved.
