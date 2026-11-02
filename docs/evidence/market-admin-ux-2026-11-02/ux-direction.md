# Claude UX direction

Actual Claude Opus 5 reviewed three fresh PNGs and both current UI sources. Requested effort: medium. This is a UX prescription, not browser testing or a code sign-off. The full returned evidence is in [ux-direction.json](ux-direction.json); model/image/source receipts are in [ux-direction-receipt.json](ux-direction-receipt.json).

## Direction

Make the common workflow **understand state → launch refresh → follow result**. Configuration and benign diagnostics become secondary. Reduce visible decisions and repeated explanations; preserve every required capability and the incumbent dark/gold identity.

## Six changes

1. **One decision strip instead of six equal status cells.** Remove healthy/idle boilerplate and absolute update timestamps from the default view. Relegate league, healthy worker/scheduler, heartbeat, versions and cron to Connection details. Retain coverage, next refresh, warnings and degraded sources; promote unhealthy services visibly. Evidence: current status grid, TSX813–891/CSS48–54.

2. **Put scope and Run now in the top action toolbar.** Remove the separate refresh-card introduction, polling subtitle and benign “Manual refresh is available” hint. Relegate technical rate-limit details to diagnostics. Retain scope, conditional recipe-ID input/validation, busy state and every actual disabled reason. Pause remains adjacent, with unchanged semantics. Evidence: mobile Run now roughly800px down; TSX411–415/483.

3. **Make runs the main result surface.** Terminal successes become compact scope/status/relative-time rows. Move IDs, absolute times, query/freshness metadata and raw diagnostics into per-run details. Keep active progress, counts, Cancel, cancellation-requested state, failure guidance and current cooldowns immediately visible. Evidence: two dense metadata lines per run, TSX1019–1031/CSS142–145.

4. **One outer Settings disclosure.** Hide the four-group grid, version, compare action, saved status and application-semantics paragraph from the clean default view. Retain every field, range, effective-value difference, validation message, Save/Discard and concurrent-edit recovery inside. Dirty, invalid or errored settings must remain open and visibly marked. Evidence: closed Settings still consumes360–430px in the supplied images.

5. **Optional: reduce standing form prose.** Relegate repeated freshness/retention explanations to relevant help or validation. Retain group-value summaries and field limits. Do not remove the actual constraints or the required explanation of TTL versus schedule/quote age. Evidence: expanded Settings PNG; TSX736–748.

6. **Readability floor, not smaller text.** Remove sub14px metadata, especially the mobile0.72rem override. Suggested local scale: H1 24–30px/1.2; section headings17px/1.3; status16px/1.4; body15px/1.5; metadata14px/1.45. Keep44px hit targets and tabular numbers. Verify the suggested~1120px container against the uninspected global wrapper. Evidence: CSS31–34,88,119–122,142–145,295–297.

## Topology

**Desktop:** header/Pause → scope/Run toolbar → decision strip → full-width runs → Connection details → Settings.

**Mobile:** same order; toolbar immediately below the title, status facts wrapping two per row, compact terminal runs, then disclosures. Default-collapse benign diagnostics, settings and terminal-run details.

## Guardrails and checks

- Common read/run/watch/result loop requires no disclosure clicks; Run now is above the fold.
- Keep warnings, degraded sources, meaningful cooldowns, blocked-action reasons and active Cancel visible.
- Never discard drafts or close a user-opened settings group on polling. Open/focus invalid fields safely; keep401/403 and409 recovery discoverable.
- Preserve safe Pause, cancellation semantics, validation, auth and draft protection.
- Check14px minimum text and44px targets at1440/390; dirty drafts survive polling and comparison.
- Product judgment: retaining a compact league identity may be safer than hiding all market context. Do not mechanically use a controlled false `open` prop that closes disclosures on refresh.

## Limits

Static screenshots/source only. Active, error, loading, paused and unhealthy states were inferred, not exercised. Shared tokens, global container and root rem size were outside scope. No measurements, browser actions, tests or source edits were performed by Claude.
