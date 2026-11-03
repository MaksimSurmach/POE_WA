# Market administration UX distillation — 2026-11-02

Baseline: `e4fe03d` in draft PR #27. Scope is `/admin/market`, without backend,
authorization, provider, retention or handbook behavior changes. No merge/deployment.

## Direction and review

Claude Code, actual `claude-opus-5` / firstParty, completed a 142-second UX direction
using three actual PNG Reads and both current UI sources. An independent parent
layout/type assessment and clean mechanical scans were synthesized afterward.
The goal is one task path: understand state, choose scope, launch, follow outcome.

[Claude direction](ux-direction.md) · [Full direction](ux-direction.json) ·
[Model/image receipt](ux-direction-receipt.json) ·
[Independent layout/type assessment](parent-assessment.md)

Claude then read three after PNGs and both updated sources in an 86-second final
check. It marked all six prescriptions delivered. Its remaining finding was badge
title-casing; the original finding/verdict is retained rather than rewritten.
The parent removed title-casing, supplied sentence-case run labels, and confirmed
the result in Chromium. That final copy correction is after Claude's review;
there is no claim of a third Claude approval.

[Final Claude check](ux-final.md) · [Full result](ux-final.json) ·
[Review receipt](ux-final-receipt.json)

## What changed

- Scope and Run now form the first action band. Removed repeated instructions and
  the normal-state availability message; blocked-action reasons remain visible.
- Six equal status cells became four compact facts: league, freshness, next refresh
  and sources. Healthy-worker/idle-run details and transport metadata are on demand.
  Worker problems, live schedule warnings, source degradation and cooldowns remain
  visible. Inactive configuration warnings remain accessible in Settings.
- Terminal results became expandable rows. Counts, timestamps, raw errors and
  freshness remain in each row's details. Three results show by default; More runs
  preserves the rest. Active work sorts first with progress and Cancel always exposed.
- One Settings disclosure replaces four always-visible closed groups. Its opened
  form uses headings, so every field is accessible with one disclosure click.
  Errors/dirty state open it; polling leaves its open state, focus and values alone.
  Save/Discard appear for edits. Compare latest settings still merges without loss.
- Recipe scope offers catalog titles through the existing validated public client.
  Failed/empty catalog loading retains manual-ID entry; loading is bounded at 15 s.
- Body/fields are 16 px, metadata is at least 14 px; 44 px targets, native focus and dark/gold
  identity are retained. Density comes from fewer visible elements, not smaller type.

No setting, scope, cancellation path, diagnostic field or historical record was
removed. Settings and benign metadata cost one extra disclosure click in exchange
for the common refresh flow staying in the first viewport.

## Rendered verification

| Width | Page height before → after | Run top before → after | Min text | Overflow |
| ----- | -------------------------- | ---------------------- | -------- | -------- |
| 1440  | 1578 →1000px               | 839 →276px             | 14px     | None     |
| 768   | 1958 →988px                | 830 →269px             | 14px     | None     |
| 390   | 2395 →1116px               | 1026 →346px            | 14px     | None     |
| 320   | 2608 →1161px               | 1170 →346px            | 14px     | None     |

Desktop after height includes the 1000 px viewport minimum; actual content ends sooner.
All visible button/select/summary targets measured at least 44 px.

[Before desktop](before-1440.png) · [Final desktop](final-1440.png) ·
[Before mobile](before-390.png) · [Final mobile](final-390.png) ·
[Narrow mobile](final-320.png) · [Opened settings](final-settings.png)

Eleven checks passed: recipe title→correct submitted ID, catalog failure fallback,
settings/focus surviving polling, Pause preserving edits, focused inline validation
without a request, conflict/draft recovery, status recovery, initial settings retry,
all 12 history records accessible with an older active run promoted, Cancel exposed
without opening details, and 200% CSS text scaling without horizontal overflow at 1440 px.
The latter is a text-scaling probe, not a claim of native browser zoom certification.
Four administrative mutations were fulfilled synthetically; zero real writes.
Persisted development settings remained version 4, automatic/scheduled off and unpaused.

[Checks and source hashes](browser-checks.json) · [Replay input](browser-probe.txt)

## Validation and limits

427 unit tests (64 domain, 10 contracts, 290 server, 63 web), lint, typecheck and build
passed locally. A regression keeps an older active run's cancellation outside the
collapsed older-history disclosure. PR CI re-runs PostgreSQL integration, backend
E2E, migration and both container builds for the final commit.

Claude inspected screenshots/source; the parent drove Chromium. Safari, physical
phones, screen-reader speech and a complete measured contrast audit were not run.
The initial console favicon 404 and deliberate synthetic failures are not live
service outages. Direct-loopback admin access and the unconfigured live Trade
boundary are unchanged. No production data was changed.
