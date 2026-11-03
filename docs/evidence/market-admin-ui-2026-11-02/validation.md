# Market admin UI review and correction — 2026-11-02

Scope: follow-up to draft PR #27, reviewed baseline `c3a7c89`. No merge or deployment.

## Review evidence

Actual Claude Code `claude-opus-5` read desktop/mobile PNGs, the handbook reference,
and the page/styles. It returned eight findings: operational controls were buried,
the desktop columns stretched into dead space, statuses lacked hierarchy, settings
were ungrouped and action/error feedback was too remote. Claude did not drive a browser.

[Claude findings](claude-review.md) · [Structured review](claude-review.json) ·
[Verified model/image-read receipt](claude-receipt.json) ·
[Independent browser assessment](browser-before.md)

The independent browser pass reproduced dirty settings blocking Pause, stale
recovered errors, a settings load failure stuck behind a loading gate and missing
inline relationship validation. Source detector baseline had zero findings; the
runtime line-length warning was addressed, while the inherited Inter warning was
rejected as outside this refinement's scope. No rebrand or dependency was added.

## Resulting behavior

- Collection state and Pause/Resume stay beside the page heading. Pause preserves
  unrelated unsaved settings; compare-latest also preserves edits. Discard is explicit.
- Compact status precedes operations and recent runs; grouped settings come last.
  Grid panels size to their own content. Native details retain all diagnostics.
- Disabled Run/Save have adjacent reasons. Status/source/run wording distinguishes
  a last fetch from current authorization, and a terminal skip from active work.
- Local range/relationship errors identify and focus the first invalid field;
  authoritative server cron rejection identifies the cron field. PATCH sends only edits.
- Resource errors are separate from action outcomes, clear on recovery, and settings
  can retry without waiting for status. Requests time out after 15 seconds.
  Successful reads from before a mutation are still ignored.

## Follow-up review and final corrections

Actual Claude Opus 5 completed a second review in 97 seconds, reading the four
after PNGs and both current sources. It confirmed the structural repairs and
identified three residual P2 issues: unknown-total progress, run-error guidance and
an unexplained disabled Pause. All three were then corrected and exercised in
Chromium at 1440/390/320 px. Unknown totals now use native indeterminate progress;
known failure codes have next-action guidance; blocked Pause explains why beside
the button. The raw code remains in Run details. An unhealthy worker also has its
own blocked-Run explanation.

[Claude follow-up](claude-followup.md) · [Structured output](claude-followup.json) ·
[Model/read receipt](claude-followup-receipt.json) ·
[Final conditional-state checks](final-state-checks.json) ·
[Conditional mobile capture](final-conditional-mobile.png) ·
[Final-state replay](final-state-probe.txt)

Final edits followed the second Claude review. Their verification is automated
and rendered browser evidence, not a claim of a third Claude approval.

## Measured browser result

Live read-only Chromium captures with the same persisted development settings:

| Width | Document height | Pause top | Run top | Horizontal overflow |
| ----- | --------------: | --------: | ------: | ------------------- |
| 1440  |         1578 px |    151 px |  839 px | No                  |
| 390   |         2395 px |    243 px | 1026 px | No                  |
| 320   |         2608 px |    292 px | 1170 px | No                  |

The baseline at 390 px was approximately 3991–4057 px tall, with Run near 3265 px
in the synthetic-state measurement. At 1440 px the baseline stretched operations
by about 626 px of empty interior. All visible action/summary targets now measure
at least 44 px. Before/after timestamps differ; neither capture invents market data.

[Before desktop](before-desktop.png) · [After desktop](after-desktop.png) ·
[Before mobile](before-mobile.png) · [After mobile](after-mobile.png) ·
[320 px](after-320.png) · [Inline errors](inline-errors.png)

Nine interaction checks passed: dirty Pause/compare, cross-field inline validation,
server cron validation, 409 conflict draft retention, status recovery, settings retry,
settings action independence from a delayed status request, actual 15-second status
timeout and truthful feedback for `accepted: false`.

[Machine-readable checks](browser-checks.json) · [Replay probe](browser-probe.txt)

All four mutating requests in this follow-up were fulfilled inside the owned browser
page; zero real settings/refresh/cancel writes were issued. Fixtures were captured
with GET requests. Prior actual API/worker persistence and market smoke checks are
recorded in [the original acceptance](../market-admin-2026-11-02/validation.md).

## Automated validation and limits

Node 22.23.4 / pnpm 11.8.0: 426 unit tests (64 domain, 10 contracts, 290 server,
62 web), lint, typecheck and build passed. This UI-only correction does not alter
backend/database code; complete integration/E2E checks are also enforced by PR CI.

Physical mobile, Safari, screen-reader speech and a complete measured contrast audit
were not performed. Chromium's initial missing favicon request was HTTP404;
synthetic failure/timeout probes intentionally produce network errors. No claim of
production certification or remote admin authentication is made.
