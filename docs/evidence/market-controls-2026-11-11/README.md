# Current market overview and collection controls

## Scope and decisions

The operator needs to compare every active recipe in the current league, inspect
one recipe without losing the overview, and pause or resume collection visibly.

- `rule/cover-reachable-states`: current catalog entries remain in the full table
  even without prices or usable history. Unknown activity occupies a separate
  price-only lane; measured zero stays on zero. Coincident recipes share a
  numbered point. Overlapping hit areas open a native, keyboard-accessible
  chooser containing every affected recipe and its exact values.
- `rule/name-object-scope-consequence`: Pause collection stops new scheduled and
  manual market work; an in-progress capture finishes. Resume clears that pause.
  It cannot restart a disconnected collector process. Run now requires a known,
  unpaused state and a connected collector.
- `rule/error-states-recovery`: rejected pause/resume writes are not retried
  automatically. Settings are re-read and the operator sees the current state.
  The overview has a bounded request and explicit retry.
- `rule/keyboard-complete-flow`: native buttons, selects and popover dismissal;
  the full recipe table remains an alternative to pointing at crowded marks.

## Reproduced cause

Read-only GETs to the private homelab API on 2026-11-11 found:

- `/api/catalog`: current Standard collector, 55 recipes; 44 fresh observed ask
  ranges and 15 recipes with measurable activity.
- `/api/trends?range=7d`: 55 current-league entries, 20 recorded ask summaries.
- `/api/trade-history?range=24h`: archived Allflame, 63 targets, no chartable exit
  rates. The old Market overview used this separate legacy source.

The current overview now reads the same catalog as Craft opportunities. Each
response carries its pinned league identity; results and readiness are filtered
to that identity. Market withholds historical percentages and selected history
when independently arriving responses belong to different leagues. The catalog
header also retains its observation league if discovery has already advanced. Historical
ask changes stay visible in its table. Recipe history is selected explicitly,
and selection keeps the overview. Chaos and divine axes are separate. Asking
prices and inferred exits are not confirmed sales, turnover or profit.

Market previously replaced shared graphite colors with a separate blue-green
surface palette and a different content width. It now uses the shared shell,
typography and surface tokens.

## New-league preparation

The resolver now excludes Hardcore, Ruthless and SSF modes even when a provider
lists one first. A database rollover check switches from Standard to a synthetic
challenge league, checks 94 old targets are disabled and 94 new targets enabled,
checks economy league selection, preserves old rows, and repeats synchronization.

Live GGG Trade and poe.ninja league catalogs currently agree on Standard and
Hardcore only. This is preparation and synthetic rollover acceptance, not proof
of launch-league supply, craft probabilities, profit or steady-state load. Existing
cost and currency-conversion evidence gates remain in force.

## Verification

Node 22.13.0; isolated PostgreSQL 17 database; headless installed Google Chrome.
No production collection setting, factory record or database was changed.

- 868 unit tests plus the native runtime check; lint, typecheck and production build.
- 189 PostgreSQL integration tests, including collector schedule/rollover, and
  eight backend E2E tests.
- Browser pause/resume, reload persistence, conflict recovery and Run now.
- Concurrent quote-age edits retain edited fields, rebase untouched fields, show
  current server values, and
  require an explicit second save before overwriting a conflicting age.
- Delayed old-league overview and selected-history responses cannot mix with new
  catalog observations; reload restores matched data.
- All recipes, coincident-point chooser, missing prices, explicit detail selection,
  preserved overview and no requests to the archived Trade-history endpoint.
- Computed palette, heading typography and main width across catalog, library,
  recipe, Pohx recipe, Market and Factory at 390 and 1440 pixels.
- Frozen live 55-recipe overview at 320, 390, 768 and 1440 pixels; all 44 priced
  recipes represented, 55 table rows and no uncaught browser errors.
- Populated synthetic Factory acceptance at 390 and 1440 pixels, including partial
  sales, rejected response/retry, accounting and JSON export.

Safari/Firefox and real new-league economics were not checked. Claude authored the
collection-control changes but reached its quota before final review. Two
independent Codex review passes found three issues, now fixed and cleared; see
[codex-review.md](codex-review.md). Final Claude approval has not been obtained.
