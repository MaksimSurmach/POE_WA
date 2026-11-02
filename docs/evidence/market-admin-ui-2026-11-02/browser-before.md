# Assessment B — deterministic scan and fresh browser evidence

Target: `apps/web/src/AdminMarketPage.tsx`, HEAD `c3a7c89`; live `http://127.0.0.1:5179/admin/market`.
Method: isolated Assessment B in new Playwright CLI session `poe-ui-assessment-b`. Assessment A outputs were neither read nor received. This is evidence for the parent's dual-assessment synthesis, not an independent final critique or redesign proposal.

## Existing authority and scan

`impeccable context --target apps/web/src/AdminMarketPage.tsx` ran. It resolved no PRODUCT.md, DESIGN.md or surface brief; it expressly permits narrow refinement on the incumbent implementation. Existing authority is the Handbook's dark surfaces, amber accent, native controls, system/Inter typography and shared StatusPanel. Preserve this identity and the handbook.

Target slug: `apps-web-src-adminmarketpage-tsx`. No critique ignore list existed.

CLI command: `/Users/maksimsurmach/.agents/skills/impeccable/scripts/impeccable detect --json apps/web/src/AdminMarketPage.tsx`.
Result: exit **0**, JSON **[]**, **0 findings / 0 rules / no flagged source locations**. This does not validate interaction quality.

Runtime overlay: mutable preflight succeeded (title changed, script tag appended and executed). `http://localhost:8400/detect.js` was injected and created overlay DOM; console reported:

- **line-length**: `~109 chars on 3 of 4 rendered lines (aim for <80)`. Likely the small, long explanation paragraph at `AdminMarketPage.tsx:373` (`.market-admin__explanation`); location is inferred from rendered length rather than a console source selector.
- **overused-font**: `Primary font: inter (100% of text)`; incumbent declaration is `styles.css:4`. Treat this as a false positive for a narrow operational surface that should reuse its application's typography. It is not a reason to change fonts.

Two runtime heuristic signals were emitted, versus zero source-detector findings. Overlay execution and screenshot are verified. The session was headless: **do not claim the user has a live visible [Human] tab**. The title was labelled [Human], but the reliable deliverable is the saved overlay screenshot.

## Browser evidence

Direct live baseline: desktop **1440×1100**, screenshot `assessment-b.desktop.png`, document height **2439px**, no horizontal overflow.

- Market status panel is 344px high. Refresh controls start at y=759px; **Run now is at y=1074px**, beyond a 900px laptop viewport.
- Settings and refresh cards both stretch to **1071px** high. The refresh card's last content ends at y=1204px while its card ends at y=1830px: approximately **626px of empty card**. `adminMarket.css:46` stretches the 1.5fr/1fr grid children to the taller settings card.
- Seven numeric inputs, raw cron, three checkboxes and repeated “Effective” values are all visible at once. Numeric field rows are ~129px apart despite 44px inputs. Helper text is **12.48px**.
- Direct live content contains English labels with a Russian Trade explanation, `poe.ninja: succeeded`, raw `MARKET_COLLECTION_PAUSED`, and a **skipped** run described as **Not finished** although its expanded Finished timestamp exists. The last mapping is `AdminMarketPage.tsx:659` (null duration is equated with unfinished).

Mobile: the complete component with captured live response data and isolated synthetic networking was measured at **390×844**, document **4057px**, no horizontal overflow. **Save settings y=2875**, **Pause y=3094**, **Run now y=3265**. A final direct live mobile capture measured height **3991px** and likewise showed only status content in the first viewport. The 66px difference is transient action feedback in the synthetic state, not a breakpoint discrepancy. At **320px**, scrollWidth was **320** and no target elements exceeded the viewport.

Buttons/inputs are 44px high. Checkbox glyphs are 18px, but their labels are 44px targets, so the glyph size alone is not a defect. Both Run details summary targets are **36px** high (`adminMarket.css:157`), below a 44px mobile target.

Keyboard: native controls were reachable. Visible focus was consistently **2px amber with 4px offset**. From the focused brand link, Pause requires **14 Tab presses** and Run now **16**, because the complete settings form precedes actions in DOM order. No keyboard trap was found in the 18-control walk.

## Reproduced interaction issues, ranked for synthesis

### [P1] Unsaved unrelated settings disable Pause

Read-only local draft change: timeout 12→13 seconds. Pause became disabled, Save became enabled, and the page instructed “Save or reload settings before pausing or resuming.” A 3-second status poll correctly preserved the draft.

This prevents the immediate operational stop action until the operator saves or discards an unrelated edit. Source: `AdminMarketPage.tsx:405`–428 (`disabled={busy || dirty}`), and `acceptSettings` overwrites the draft.

Refinement direction: keep pause/resume independent of the editable draft; preserve dirty fields through that operation. Make discard explicit instead of using reload as an implicit discard.

### [P1] Loading, status recovery and settings recovery share one coarse gate

All following failure states are **synthetic browser-route interception**, not claims that the live service failed:

1. Initial `/status` requests returned HTTP503; after restoring successful responses, Market connection returned on the next poll but **the red “Admin request failed (503)” alert remained**. Source: `AdminMarketPage.tsx:171`–187 sets errors on failure but never clears polling errors on recovery.
2. Initial `/settings` requests returned HTTP503; after backend responses were restored, subsequent status polls succeeded but **Loading market controls remained**. Settings had only the two development StrictMode initial requests, no retry. Manual Reload settings recovered the form.
3. A deliberately deferred `/status` response kept the entire control page in Loading. Pressing Reload settings started another deferred status request and disabled the reload button; no UI cancellation/recovery action was available until responses were released. Source: shared `Promise.all` and `act` busy lifetime, plus render gate at line 253. This observed deferred state is not a claim that a finite browser network timeout never occurs; the client defines no application timeout/cancel path.

Refinement direction: distinguish initial settings, live status, action outcome and stale/offline state. Keep available controls visible, clear only the recovered request's error, and provide bounded retry/cancel behaviour.

### [P1/P2] Invalid settings do not identify what to correct and the error is offscreen

**Synthetic HTTP400** for an otherwise native-valid cross-field combination (maximum quote age 5 minutes while reuse TTL remains 30 and warning remains 15): the message was only “The market query is invalid.” No field had `aria-invalid`; the 5-minute draft was retained. The alert's top was **−1197px** relative to the current 900px viewport after pressing Save. Focus had fallen to BODY when controls were disabled; no focus/scroll moved to the error.

**Synthetic HTTP409** produced the same message for version conflict and active-operation conflict: “Settings changed or another operation is active. Reload settings before retrying; unsaved values are preserved.” Draft stayed at 13 seconds, but pressing Reload settings resets it to 12, silently discarding the edit.

Source: request error mapping `AdminMarketPage.tsx:40`–50; submit parsing line 289; top-level alert; no field error association.

Refinement direction: inline field/cross-field messages, `aria-invalid` + described help, focus first invalid field or an error summary, and distinct conflict actions. P1 if operating under failure pressure; P2 for normal configuration editing.

### [P2] Task hierarchy produces excessive scrolling and a visibly empty second column

Desktop measured 626px empty space inside Refresh controls. On mobile the actions follow the entire settings form, with Run now at ~3.2kpx document depth. Recent run history starts at y=1850 on desktop. This is a composition/DOM-order problem rather than horizontal overflow.

Source: `adminMarket.css:46`–55, 173–190; settings-before-actions order `AdminMarketPage.tsx:276`–518.

Refinement direction: put current operational state and Run/Pause first; group status compactly; separate common settings from retention/advanced details; prevent short cards from stretching to long forms. Preserve every required runtime control.

### [P2] Operational wording obscures actual state

A skipped, terminal run says “Not finished”; connection status uses the last attempt's lower-case `succeeded`; technical errors are raw all-caps codes; one Trade description switches to Russian; permanent schedule/TTL warning occupies a large banner even when automatic collection is disabled. These were seen in the **direct live** baseline, not fabricated error fixtures.

Refinement direction: distinguish connection vs last check, terminal skip vs active run, readable cause vs technical detail, and one language. Keep the mismatch warning, but tie it to schedule context and provide a clear setting action.

## What did hold up

- Draft survives normal polling.
- Optimistic conflict retains values until an explicit reload.
- Native form controls, accessible labels, strong keyboard focus and 44px primary targets.
- No overflow at 390px or 320px.
- Incumbent dark/amber system is consistent with the handbook.
- Historical count/median/error and details are visible without charts or catalog tools.

## Failures, false positives and limits

Two earlier probe attempts timed out because “fail first response only” injection was consumed by React development StrictMode's duplicate initial effects. Corrected to fail the entire initial phase, then restore success. These are test-harness failures, not product findings; raw failed runs are retained for honesty.

The runtime Inter warning is a false positive in this scope. CLI zero findings is not proof the page is good. No physical phone, native screen-reader speech, full contrast audit or successful real administrative mutations were checked. No real refresh, settings PATCH, pause or cancel was issued. Every mutating request in the probes was intercepted and fulfilled inside the owned browser page; the final successful probe records two synthetic PATCH responses and zero real writes.

## Cleanup / handoff

Owned Playwright session `poe-ui-assessment-b` was closed. Owned overlay server PID **53244**, port **8400**, stopped with `kill -TERM 53244`; `impeccable live-server stop --keep-inject` then reported no running server, process lookup was empty, and health connection was refused. Overlay DOM was removed before state probes. No user's tabs, parent's session, backend or dev server were closed.

The two exact CLI-generated snapshot/console files were copied into this report directory and removed from the shared `.playwright-cli` folder; shared directory and other agents' files were left untouched. Reports, scripts and screenshots are intentionally retained under `assessment-b.*` for synthesis. No source edits, commits or builds.

Primary files: `assessment-b.evidence.json` (machine-readable results), `assessment-b.detector.json`, `assessment-b.browser-console.log`, `assessment-b.desktop.png`, `assessment-b.mobile-first-screen.png`, `assessment-b.mobile.png`, `assessment-b.overlay.png`, `assessment-b.synthetic-field-error.png`, `assessment-b.synthetic-stale-error.png`, `assessment-b.synthetic-hanging.png`.

Questions skipped: Assessment B only; the parent must synthesize with independent Assessment A before asking the user.
