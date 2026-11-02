# Claude Code UI/UX follow-up

Actual model: `claude-opus-5`; provider: `firstParty`. Requested effort: medium; served effort unverified. Completed in 97.34 seconds.

Claude Read all four actual after-screenshots and both current UI source files. It did not drive a browser or execute tests. Source hashes in the receipt identify the uncommitted version actually reviewed.

## Verdict at review time

remaining material UI fixes needed

Seven of the eight original operator problems are genuinely fixed in the current build: the dead right column is gone (status full-width, then a Run/Recent-runs pair, then full-width Settings), mobile now leads with pause/status/run and ends with Settings, Reload no longer owns the prime slot, blocked Run now explains itself inline, the status grid has colour/state encoding and even rows, settings are four collapsible groups with value summaries and no repeated "Effective:" noise, and feedback is class-styled and co-located per area. Only issue 8 is partly done: run status badges and progress exist, but non-pause error codes are still near-raw constants and the in-flight <progress> renders as a determinate bar pinned at 0% when totalQueries is still 0, which reads as "stalled". One smaller residual of issue 4 remains: the Pause/Resume control can be disabled with no adjacent reason. All are local, low-risk text/condition fixes; no layout rework is needed.

## Original eight issues

### 1. resolved

after-1440.png: full-width Market status card (y≈250-535), then Run a refresh (left, ends y≈990) beside Recent runs (ends y≈1035), then full-width Settings (y≈1060-1430). No large empty column. CSS lines 42-47 grid-template-columns minmax(0,1fr)/minmax(0,1.4fr) with align-items:start; Settings sits outside the two-column wrapper (TSX 516). Residual whitespace under the Run panel is ~45px, not operationally relevant.

### 2. resolved

after-390-top.png: at the fold the operator sees back-link, title, 'Accepting New Work' badge and 'Pause new collections' button (y≈250-285), then Market status, then 'Run a refresh'. after-390.png: Settings is last (y≈1400+). DOM order TSX 331-372 (header + pause) → 389 (run/runs columns) → 516 (settings).

### 3. resolved

Reload is gone; its replacement is a neutral secondary 'Compare latest settings' inside the Settings header (after-1440.png y≈1108; TSX 529-541). Pause is header-level and warning-coloured (CSS 167-170; after-1440.png top-right amber-outlined button) next to a live state badge. Pause is reversible and its success copy states active work may finish (TSX 362-364), so immediate firing is acceptable. 'Run now' is the accent submit in the Run panel (CSS 111-114).

### 4. partially resolved

Run now always carries a reason line: after-1440.png y≈900 'Manual refresh is available.'; TSX 459-468 with runDisabledReason (315-327) covering busy/no-status/active-run/paused/missing-recipe-ID. Save settings disabled state is explained by the adjacent 'All changes saved' (after-1440.png y≈1347; TSX 737,764). Gap: the Pause/Resume button is disabled on `busy || !settings` (TSX 351) with no adjacent reason; the settings load error renders far below in the Settings panel (TSX 543-547).

### 5. resolved

after-1440.png y≈320-445: six labelled cells in an even 3x2 grid with state colour (amber 'Trade: Not configured', green 'Healthy / Healthy', amber '0/2 fresh') plus secondary sub-lines; CSS 48-54 repeat(3,minmax(0,1fr)), 289-291 drops to 2 columns ≤600px (after-390.png y≈300-470, after-320.png y≈345-535 — no ragged trailing row, no overflow).

### 6. resolved

after-1440.png y≈1160-1275: four collapsed groups (Automation, Requests, Freshness, Retention) in two columns, each summary carrying a current-value digest ('12s timeout · 4 concurrent', '96h raw · 14d history'); TSX 600-734, CSS 218-238. 'Effective:' is now conditional on drift only (TSX 715).

### 7. resolved

notice() renders a classed, role-annotated paragraph scoped per area (TSX 303-314), placed inside the control's own container: collection TSX 370, refresh inside the run form TSX 469, runs TSX 513, settings TSX 777. Styling via .market-admin__success / .market-admin__error (CSS 152-155, 192-197). Not exercised in the four snapshots — inferred from source, not visually tested.

### 8. partially resolved

Badges are colour+dot encoded: after-1440.png 'Skipped' amber (y≈683) and 'Succeeded' green (y≈889); TSX 967-972, CSS 176-191. MARKET_COLLECTION_PAUSED is translated to 'Skipped because collections are paused.' (after-1440.png y≈776; TSX 996-997). Still unresolved: every other errorCode falls through to `replaceAll('_',' ').toLowerCase()` (TSX 998), and the in-flight <progress> (TSX 987-993) uses max=Math.max(1,totalQueries) with a value, so an unknown-total run (totalQueries 0, as in the '0/0 queries' run) paints a determinate bar at 0% rather than an indeterminate one.

## Remaining material defects found

### [P2] In-flight run with unknown total shows a determinate 0% bar instead of indeterminate

Image region: after-1440.png / after-390.png, Recent runs panel, first run block under '0/0 queries complete' (1440: y≈742); the bar is absent here only because the run is finished

Source: AdminMarketPage.tsx 987-993: <progress max={Math.max(1, run.totalQueries)} value={run.completedQueries + run.failedQueries} />

Operator impact: A queued/running refresh whose totalQueries is still 0 renders an empty, apparently frozen bar, so the operator reads a healthy run as stalled and may cancel or re-fire it.

Minimal fix: Omit the value attribute when run.totalQueries < 1 (e.g. spread {...(run.totalQueries > 0 ? { max: run.totalQueries, value: run.completedQueries + run.failedQueries } : {})}) so the native indeterminate state is used until the total is known.

### [P2] Non-pause run failures still surface as de-underscored raw error constants

Image region: after-1440.png Recent runs, red line at y≈776 (the one translated case); any other code renders in the same slot

Source: AdminMarketPage.tsx 994-1000 — only MARKET_COLLECTION_PAUSED is mapped; the fallback is run.errorCode.replaceAll('_', ' ').toLowerCase()

Operator impact: Common failures (auth, cooldown, rate limit, upstream unavailable) still read as machine strings with no next action, leaving the operator unsure whether to retry, wait, or fix configuration.

Minimal fix: Reuse the existing lookup-map pattern from sourceLabel() (lines 924-938): add a small runErrorLabel map for the handful of known MARKET_* codes with one-line guidance, keeping the current lowercase fallback for unknown codes. The exact code stays visible in the Run details <dl>.

### [P2] Pause/Resume can be disabled with no adjacent reason

Image region: after-1440.png header top-right (y≈173); after-390-top.png y≈265

Source: AdminMarketPage.tsx 349-369 — disabled={busy || !settings}; the only nearby text is the badge 'Checking collection status' (343-347), while the settings-load error appears in the Settings panel far below (543-547)

Operator impact: If settings fail to load, the most safety-critical control is greyed out at the top of the page with no explanation; the operator must scroll to the bottom panel to learn why pausing is unavailable.

Minimal fix: Render a short reason in the existing .market-admin__collection paragraph slot (CSS 171-175) when the button is disabled, e.g. 'Settings unavailable — retry in Settings.' or 'Applying a change…', mirroring the admin-run-reason pattern already used for Run now.

## Coverage limits

- Only four static snapshots were supplied (1440, 390 full, 390 fold, 320). No browser was driven: hover, focus, open <details>, scroll and reflow between breakpoints were not observed.
- Conditional states were never rendered in the images — success/error notices, dirty Save + Discard row, field-level aria-invalid styling, the recipe-ID field, active-run progress bars and Cancel run. These are judged from source only, per instruction.
- No contrast measurement, keyboard-order, screen-reader or performance verification; colour judgements are qualitative from the PNGs.
- Expanded settings groups were not captured, so internal density of Automation/Requests/Freshness/Retention (CSS 79-83 two-column fields) is unverified at 320px, though the ≤600px single-column rule at CSS 301-303 covers it in source.
- Scope limited to the two named source files and four PNGs; backend, contracts and retention semantics were not reviewed.

## Subsequent parent-owned resolution

All three residuals repaired: unknown-total progress is indeterminate; known errors have operator guidance; disabled Pause/Resume has an adjacent reason. Parent reports web62 tests/typecheck passing and rendered Chromium states at1440/390/320 with no overflow or writes.

Those final edits happened after this Claude review. This report preserves the findings as returned and does not claim that Claude reviewed or approved the subsequent edits.
