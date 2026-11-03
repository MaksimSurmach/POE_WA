# Claude Code visual UI/UX review

Reviewed source: `c3a7c89fb98bde4993f17473639acaaef2727d56`. Actual model: `claude-opus-5`; provider: `firstParty`. Requested effort: medium; served effort unverified.

Claude Read the actual desktop, mobile and handbook-reference PNGs (one successful image block each), plus the four requested source/style files. Claude did not drive a browser.

## Verdict

The page is functionally complete and faithful to the Worksmith dark/gold tokens, but the "bad and crooked" complaint is justified. The two-column grid leaves roughly half the right column as dead space on desktop; the mobile stack buries every operational control under a long settings form; and the loudest slot goes to the least important action (Reload settings) while the safety-critical pause, the Save affordance, and every connection/run state render as undifferentiated grey-on-dark text. Eight concrete defects follow, six essential.

Section order and column proportions follow DOM convenience rather than operator priority: the rarely-edited settings form takes the dominant 1.5fr column (and the first screenfuls on mobile), while the things an operator opens this page for — connection state, pause, run now, run progress — are squeezed into a short right column that ends in a large empty rectangle, or pushed ~2,300px down on mobile. Compounding it, no state is visually encoded (no status colour, badge, or progress), so the whole page reads as one flat grey wall.

## Preserve

- Correct incumbent identity: gold accent headings/links, --surface panels, 8px radius, Inter stack, reuse of the shared StatusPanel in warning/danger tones. adminMarket.css uses only styles.css tokens — no invented palette.
- Sound semantics: dl/dt/dd for connection status, fieldset+legend, aria-labelledby on every section, aria-label on per-run cancel buttons (AdminMarketPage.tsx:278, 307, 690).
- 44px minimum hit targets on inputs, buttons and checkbox rows (adminMarket.css:74, 96-97, 105) plus the inherited gold :focus-visible outline (styles.css:58).
- Honest, non-euphemistic operational copy ('Active work finishes when paused', 'Cancel a run separately to request its safe stop') — keep the wording verbatim.
- Conflict/permission handling already produces specific recoverable messages for 401/403 and 409 (AdminMarketPage.tsx:36-43) rather than generic failures.
- Polling guarded by a generation counter and actionPending ref so background refreshes do not clobber in-flight actions (AdminMarketPage.tsx:140-141, 171-190).

## Ranked defects

### 1. [P1] Right operations column collapses into ~500px of dead space while settings sprawl

Classification: essential usability. Evidence basis: visible screenshot.

Visible evidence: `before-desktop.png` - Right column 'Refresh controls' panel, x≈700-1080, y≈620-1500. The panel's content ends at 'No recorded rate limits.' around y≈978, but the bordered panel continues to y≈1500 — roughly half the panel is empty. Meanwhile the left settings panel is crammed with eight stacked fields and a five-line prose block. The page's visual weight sits on the least-used content, which is exactly the 'crooked' impression.

Source: adminMarket.css:46-50 — .market-admin__columns is grid-template-columns: minmax(0,1.5fr) minmax(0,1fr) with default align-items:stretch, so the short operations panel is force-stretched to the settings panel's height; AdminMarketPage.tsx:275-518 puts the settings section first and the operational section second inside that grid.

Operator impact: Operational controls (pause, scope, run now, cooldowns) occupy the narrow, visually secondary column, so the operator's primary tasks compete with a configuration form they rarely touch. The empty rectangle also makes the page look broken and wastes the fold.

Recommendation: Stop pairing these two in one grid. Promote operations to a full-width band directly under the status/alerts, split into 'Refresh controls' plus 'Active run and recent runs' so both halves carry content; move 'Collection & settings' to a full-width panel below it. If any grid remains, add align-items:start so panels size to content rather than stretching.

### 2. [P1] On mobile the settings form is placed ahead of every operational control

Classification: essential usability. Evidence basis: visible screenshot.

Visible evidence: `before-mobile.png` - Full-page order: Collection & settings starts y≈650/3991; Refresh controls heading y≈2290; Recent runs y≈2850 (390px viewport). At 390px the page is ~4,000px tall; the pause button, refresh scope and Run now sit about six screenfuls down, and run history is below that. The first thing a mobile operator meets is eight numeric configuration inputs.

Source: adminMarket.css:173-179 — the 850px breakpoint only flattens .market-admin__columns to 1fr with no order override, so the DOM order of AdminMarketPage.tsx:276-517 (settings section first) becomes the vertical order.

Operator impact: The time-critical task ('safely pause new collection', 'check what is running') becomes a long scroll on the device most likely used for an urgent intervention, while the low-frequency task is front and centre.

Recommendation: Reorder for mobile: status summary → alerts → pause/run controls → active and recent runs → settings last. Do it with DOM order plus CSS order (or render order), not display tricks, so focus order follows. Collapse the settings panel into grouped <details> on small screens.

### 3. [P1] Action hierarchy inverted: Reload owns the prime slot, pause looks like any neutral button and fires immediately

Classification: essential usability. Evidence basis: visible screenshot.

Visible evidence: `before-desktop.png` - Header button 'Reload settings' top-right x≈965-1083 y≈130-165, versus 'Pause new collections' at x≈715-870 y≈742-775. 'Reload settings' is the single button in the page header, the most prominent action position. 'Pause new collections' — the state-changing safety control — is a plain surface-raised button of identical weight, inside a secondary column. Only 'Save settings' and 'Run now' carry the gold accent treatment, so a destructive-ish toggle and a benign reload are visually indistinguishable.

Source: adminMarket.css:104-116 — all .market-admin buttons share one neutral style; only button[type='submit'] gets accent colour. AdminMarketPage.tsx:405-426 — the pause toggle calls act() straight from onClick with no confirmation and no distinct styling; AdminMarketPage.tsx:241-252 — Reload sits in the header.

Operator impact: Risk of an accidental single-click pause of all collection, and the reverse problem of hunting for the pause control during an incident. The button label also changes identity (Pause/Resume) with no persistent, legible state indicator next to it beyond a sentence of body copy.

Recommendation: Give the collection state a persistent pill in the page header ('Accepting new work' / 'Paused', using --success / --warning), with the pause/resume toggle beside it styled as the page's one state-changing control (warning-toned outline). Demote 'Reload settings' to a quiet text button inside the settings panel header, next to the version line. Add a lightweight inline confirm step for pause, not a modal.

### 4. [P1] Silently disabled primary actions: Save and Run now give no reason when blocked

Classification: essential usability. Evidence basis: source-inferred interaction/state.

Visible evidence: `before-desktop.png` - 'Save settings' at x≈117-222 y≈1448-1480 rendered at ~50% opacity; 'Run now' x≈715-790 y≈883-915 (inferred states; visible parent regions are the Collection & settings and Refresh controls panels). Save is visibly greyed with no adjacent explanation. In the captured state it is disabled because nothing is dirty, which is fine, but source shows the same flat grey is used for several very different blocked conditions.

Source: AdminMarketPage.tsx:381 — disabled={!dirty || busy}, with the only explanatory text being the 'Unsaved changes' span which appears when dirty (384-388). AdminMarketPage.tsx:477-493 — Run now is disabled by busy, !manualAvailable, !!status.activeRun, or an empty recipe id, but the only hint rendered is for manualAvailable; an active run or an empty recipe id disables the button with no message. adminMarket.css:117-120 applies a single opacity:.5 to all disabled states.

Operator impact: During an incident the operator clicks Run now, nothing happens and nothing explains why — most often because a run is already active. Same for Save when validation rejects the draft: the error surfaces as a generic 'Check the setting limits before saving.' at the top of the page (line 294), nowhere near the offending field.

Recommendation: Always render a short reason beside a disabled primary button: 'A refresh is already running — cancel it or wait', 'Manual refresh is off', 'Enter a recipe ID'. Keep the pending label pattern ('Applying…') but pair it with an aria-busy state. For save validation, mark the offending field inline using min/max from numericSettings rather than only a page-level banner.

### 5. [P2] Market connection grid has no state encoding; nine equal tiles with ragged rows

Classification: essential usability. Evidence basis: visible screenshot.

Visible evidence: `before-desktop.png` - 'Market connection' panel, 3x3 dl, x≈100-1080 y≈218-498. 'Allflame · Confirmed', 'Not configured', 'succeeded', 'Healthy / Healthy' and '—' all render in identical white at identical size; nothing distinguishes healthy from unconfigured from failing. The 'Trade' cell carries a three-line Cyrillic reason that pushes the first row much taller than its neighbours, so row two starts at an uneven baseline relative to the tiles beside it — the visible source of the 'crooked' feel in this block. Row-2/3 labels also sit at different vertical offsets across columns.

Source: AdminMarketPage.tsx:546-620 renders all values as plain dd text with optional <small>; adminMarket.css:51-56 uses a flat repeat(3, 1fr) grid with 22px gap and no row alignment or per-state class, despite styles.css:276-324 already providing freshness/evaluation-status dot patterns and --success/--warning/--danger tokens.

Operator impact: 'Quickly see connection/league/schedule' fails: the operator must read nine labels to discover that Trade is unconfigured and that automatic refresh is off. Uneven row heights make scanning harder still.

Recommendation: Group the nine items into three labelled clusters — Connection (league, Trade, poe.ninja), Health (worker/scheduler, last success, last failure), Schedule & coverage (next refresh, coverage, active refresh) — and reuse the existing dot-plus-label pattern so each value carries a success/warning/danger dot. Give each cell a consistent min-height and align-content:start, and clamp long provider reasons to two lines with a details disclosure. Do not change what the provider text says.

### 6. [P2] Settings form is one undifferentiated stack with 'Effective:' noise repeated under every field

Classification: essential usability. Evidence basis: visible screenshot.

Visible evidence: `before-desktop.png` - Collection & settings panel, x≈117-660 y≈755-1400. Three unlabelled checkboxes, a cron field, then seven numeric fields in a flat 2-column grid. Every field repeats an 'Effective: N' line that in this state duplicates the value already in the input (12/12, 4/4, 30/30, 15/15, 30/30, 96/96, 14/14) — seven redundant grey lines. Timeout and concurrency sit beside each other, but TTL, freshness warning, quote age and two retention values are visually one undivided mass despite being three different concerns.

Source: adminMarket.css:81-92 — .market-admin__fields is a single repeat(2, 1fr) grid for all seven numericSettings entries (AdminMarketPage.tsx:87-137) with no sub-grouping; the <small>Effective: …</small> is emitted unconditionally at line 367-369. The checkbox group's only heading is a visually-hidden legend (307-309). The explanation paragraph (373-380) refers to 'the collection interval', a term that appears nowhere as a field label — the field is 'Refresh schedule (cron)'.

Operator impact: Editing supported settings means scanning a wall of similar numeric boxes; the operator cannot tell which three fields govern freshness versus retention, and the duplicated 'Effective' lines train them to ignore exactly the text that matters when configured and effective values diverge.

Recommendation: Split the fieldset into visible sub-groups with real legends: Automation (three toggles + cron), Request behaviour (timeout, concurrency), Freshness (reuse TTL, freshness warning, max quote age), Retention (raw hours, history days). Render 'Effective' only when it differs from the draft/configured value, and when shown, style it in --warning so divergence is the signal. Align the explanation copy with the on-screen label ('refresh schedule') or rename the field.

### 7. [P2] Success feedback is an unstyled bare paragraph, and errors appear far from the control that failed

Classification: essential usability. Evidence basis: source-inferred interaction/state.

Visible evidence: `before-desktop.png` - Gap between the page header and the 'Market connection' panel, x≈100-1080 y≈190-215 (inferred state; parent region visible and currently empty). No message is present in the capture. Source shows that when one appears it renders as a plain muted sentence in that gap, with no panel, icon or accent — visually weaker than the warning banner directly below it, while the danger StatusPanel it should match is a bordered, iconised block.

Source: AdminMarketPage.tsx:259 — {message ? <p role="status">{message}</p> : null}, which inherits adminMarket.css:26-34 muted body styling; compare line 254-258 where errors get a full StatusPanel. Neither message nor error is ever cleared except at the start of the next act() call (204-205), so a stale 'Settings saved.' can sit above a later failure. The 409 copy (40-43) instructs the operator to 'Reload settings', but that button is in the far top-right header (241-252).

Operator impact: Confirmation of a safety-relevant action (pause applied, cancellation requested) is easy to miss, and on a conflict the operator reads the instruction in one corner then hunts for the button in another. Recovery from the 409 path is slower than it needs to be.

Recommendation: Render success through the same StatusPanel in its success tone so feedback has one visual language; auto-dismiss or clear it when a new error arrives. Place action feedback adjacent to the originating control (inside the operations panel for pause/run, inside the settings panel footer for save), and when the conflict message appears, put a 'Reload settings' button inside that panel so the instruction and the control are in the same place.

### 8. [P3] Recent runs: status as plain text, raw error constants, no progress for in-flight runs

Classification: optional taste. Evidence basis: visible screenshot.

Visible evidence: `before-desktop.png` - 'Recent runs' panel, x≈117-1065 y≈1530-1850. 'skipped' and 'succeeded' are right-aligned plain text at body weight — no badge, no colour, no alignment column. 'MARKET_COLLECTION_PAUSED' is shown as a raw red constant. The '0/0 queries complete' and '4/4 queries complete' lines are prose; a running job would show no progress bar. The 'Run details' disclosures are gold, giving the least important element the most saturated colour in the panel.

Source: AdminMarketPage.tsx:652-656 renders run.status as bare text; 668-670 prints run.errorCode unmapped; 663-667 renders completed/total as a sentence although styles.css:171-187 already defines a themed <progress> with accent fill. adminMarket.css:149-152 separates runs only by a top border.

Operator impact: Scanning run outcomes requires reading, not glancing, and 'inspect runs/progress' has no progress affordance at all. Raw error codes are copy-pasteable but need translation for day-to-day triage.

Recommendation: Give each run a status pill reusing the existing evaluation-status dot pattern (success/warning/danger by status), add the themed <progress> bar for queued/running rows, and show a short human sentence above the raw code (keep the code visible, in smaller mono, for support). Tone 'Run details' down to muted with the gold reserved for the accent actions.

## Coherent target layout

Order the page by operator urgency — read state, act, observe, then configure — and let every panel size to its content so no column is padded with emptiness. Keep the Worksmith dark/gold tokens, the existing StatusPanel component and all current copy and semantics; this is a re-composition, not a restyle, and the regular handbook is untouched.

### Desktop

- Header band (full width): title + 'Local operational controls · live status refreshes every 3 seconds' on the left; on the right a persistent collection-state pill (Accepting new work / Paused, success/warning tone) with the Pause/Resume toggle beside it as the page's one state-changing control. 'Reload settings' moves out of the header into the settings panel header next to 'Version N · Schedule timezone'.
- Band 1 — Market connection, full width, three labelled clusters in a 3-column grid: Connection (league, Trade, poe.ninja) · Health (worker/scheduler, last success, last failure) · Schedule & coverage (next refresh, coverage, active refresh). Each value carries a status dot; cells use a uniform min-height with align-content:start so rows cannot go ragged; long provider reasons clamp to two lines with a disclosure.
- Band 2 — Alerts: existing warning/danger StatusPanels, plus the success StatusPanel for action confirmations, directly beneath the status band.
- Band 3 — Operations, full width, split minmax(0,1fr) / minmax(0,1.6fr) with align-items:start. Left card 'Refresh controls': collection state sentence, refresh scope select, conditional Recipe ID, Run now with an always-visible reason line when disabled, and 'Rate limits & cooldowns' as a compact list beneath. Right card 'Runs': active run at the top with a themed progress bar and its Cancel button, then the recent-run list with status pills. This band carries real content on both sides, eliminating the empty rectangle.
- Band 4 — Collection & settings, full width, three columns of grouped fieldsets with visible legends: Automation (3 toggles + cron) · Request behaviour (timeout, concurrency) · Freshness (reuse TTL, freshness warning, max quote age) and Retention (raw hours, history days). The explanation paragraph becomes a short note inside the Freshness/Retention group rather than a block spanning the whole form. A panel-footer action bar pins Save settings + Discard changes + the 'Unsaved changes' indicator to the bottom edge of the panel, becoming sticky while dirty.

### Mobile

- Single column, reordered: header with state pill and Pause/Resume → compact status summary (6 highest-value items shown; the rest behind a 'Full connection detail' disclosure) → alerts → Refresh controls → Runs → Collection & settings last.
- Settings panel on mobile renders its four groups as <details> sections, collapsed by default except any group with unsaved changes, so the form stops consuming six screenfuls.
- Save bar sticks to the bottom of the viewport only while the form is dirty and the settings panel is in view; it shows the unsaved-changes label and both Save and Discard at 44px height.
- Connection clusters stack as three labelled blocks rather than nine flat rows, keeping the 480px single-column input layout already in adminMarket.css:181-196.

### Visual system

- Status encoding: reuse the existing dot-plus-label pattern and --success / --warning / --danger tokens for connection values and run statuses; no new colours.
- Button tiers: one state-changing control (pause/resume, warning-toned outline), accent-outlined primaries (Save settings, Run now), neutral secondaries (Reload settings, Cancel run), quiet text disclosures (Run details, muted not gold).
- Disabled controls always sit beside a one-line reason; keep opacity .5 but never as the sole explanation.
- Density: panel padding stays 22px/16px; tighten vertical rhythm inside the settings form by grouping rather than by shrinking type, and keep every field label at its current size.
- Progress: reuse the themed <progress> element from styles.css for active runs; no charts, no dashboards, no new components beyond pill/group wrappers.

## Implementation order

- 1. Re-order the DOM in AdminMarketPage.tsx (status → alerts → operations → runs → settings) and replace .market-admin__columns with the operations band grid plus align-items:start. This alone removes the dead column and fixes the mobile burial (defects 1, 2).
- 2. Move Reload settings into the settings panel header; add the collection-state pill + pause/resume pair to the page header with an inline confirm step (defect 3).
- 3. Add reason text beside every disabled primary (Save, Run now) and route save-validation failures to the offending field (defect 4).
- 4. Regroup the connection dl into three labelled clusters with status dots and uniform cell heights; clamp long provider reason text (defect 5).
- 5. Split the settings fieldset into four legended groups, render 'Effective' only on divergence in --warning, and reconcile the explanation wording with the cron label (defect 6).
- 6. Render success via StatusPanel success tone, co-locate feedback with its originating panel, and add a Reload settings button inside the conflict message (defect 7).
- 7. Add the sticky/footer save bar with Discard changes for the settings panel; add <details> grouping for mobile.
- 8. Optional polish last: run status pills, progress bar for active runs, humanised error code above the raw constant, muted Run details (defect 8).

## Focused acceptance checks

- At 1440px, no panel has more than ~80px of empty space below its last content element; the operations band has content in both halves.
- At 390px, the Pause/Resume control is reachable within the first viewport and Run now within the second; the settings form begins only after the runs list.
- Every disabled Save settings and Run now state displays a visible reason string within the same panel; triggering each blocked condition (busy, manual disabled, active run, empty recipe id, no changes) yields a distinct message.
- Collection paused versus accepting-new-work is identifiable from the header pill alone, without reading body copy, in both desktop and mobile captures.
- Each Market connection value shows a status dot whose tone matches its state; all cells in a cluster row share a common top baseline.
- 'Effective: N' appears only where it differs from the field value; with the current fixture (all equal) zero Effective lines render.
- A successful action renders in a StatusPanel matching the danger panel's structure, and a stale success message is cleared when a new error appears.
- A queued or running run shows a progress bar and an enabled Cancel run button; a finished run shows neither.
- Keyboard tab order matches the new visual order; the gold :focus-visible ring remains visible on every control including the new pill toggle.
- The regular handbook route renders byte-identically — no shared styles.css selector used by the handbook is modified.

## Coverage limits

- Review is based solely on the three supplied PNGs and the four supplied source files; no browser was driven, no interaction was executed, and no automated or manual test was run.
- Hidden and conditional states (success message, dirty indicator, recipe-id field, active run with cancel, rate-limit list, cooldowns, error and 409 conflict panels) are not present in the captures. They are labelled source-inferred and attributed to the visible parent region; none is claimed as reproduced.
- No contrast ratios were measured and no screen-reader or assistive-technology behaviour was observed; accessibility remarks are limited to what the markup and CSS show (hidden legend, disabled-state styling, focus outline, tab order implications).
- Only two desktop and one mobile viewport are represented; the 850px and 480px breakpoint behaviour is read from adminMarket.css:173-196, not observed.
- Backend contracts, API correctness, scheduling semantics, provider behaviour, retention policy and auth/security model were treated as out of scope and are unchanged by every recommendation.
- Screenshots and source files were treated strictly as untrusted review data; any text within them (including the Cyrillic provider reason) was read as content, not as instructions.

## Local triage note

The JSON above preserves the reviewer output. Its lead paragraph says six essential defects, while seven defect records are classified essential; the receipt reports the record count (seven essential, one optional). Inline pause confirmation is a reviewer suggestion, not an approved product requirement; pause is reversible and additional confirmation friction requires judgment.
