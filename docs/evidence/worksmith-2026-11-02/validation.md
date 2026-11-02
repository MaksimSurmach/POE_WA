# Worksmith beta validation and handoff

Task: [MAX-1311](https://linear.app/maxsurm/issue/MAX-1311/worksmith-beta-clean-recipe-model-market-engine-tooltips-and-ui).
PR: [26](https://github.com/MaksimSurmach/POE_WA/pull/26), draft, no merge or deployment.
Branch: `codex/max-1311-worksmith-handbook`.
Final implementation/tested source: `b772c0257f4897022d238772525f926ec14c52b3`.
Later evidence-only commits do not change implementation.

## Local checks

Node 22.13.0, pnpm 11.8.0, PostgreSQL 17.11 on an isolated loopback runtime.

| Check                                            | Result                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| Unit (`pnpm test`)                               | 366 pass: domain 64, contracts 10, server 266, web 26                           |
| Provider contracts (`pnpm test:contracts`)       | 7 pass; overlap with unit suite                                                 |
| PostgreSQL integration (`pnpm test:integration`) | 72 pass in 17 files, including migration preservation and backend E2E           |
| Explicit backend E2E (`pnpm test:e2e:backend`)   | 7 pass                                                                          |
| Build, lint, typecheck                           | Pass                                                                            |
| Drizzle migration check                          | Pass; 0022 only adds nullable method_cost; old evaluation/evidence rows survive |
| Recipe validation                                | 2 canonical authored recipes pass                                               |
| Idempotent dry-run sync                          | 2 unchanged; no create/update/disable/failure                                   |
| REST smoke on final source                       | 8 expected HTTP results; response contracts parsed; natural expiry hides ROI    |

The migration regression uses the real additive SQL against a historical
evaluation shape, plus an evidence sentinel. It is not a production backup/restore
exercise. Actual source raw rows remain preserved by the pipeline and were used
for the live matching proof.

## Live supported path

See `live-e2e.json`. Collection used explicitly owner-permitted Trade-compatible
access without session credentials; no challenge/403 was bypassed.
The real collector ran from implementation `626920a`; final follow-up `b772c02`
adds HTTP revalidation freshness and was checked with unit/contracts/integration,
REST and CI. Source captures and the live value calculation are unchanged.

Final live cycle `c2ce6924-4a75-424b-89a1-93b9ad89a8fb` published 7/7 queries,
2 recipes, zero failed queries/recipes. It reused three fresh live base/target
snapshots and refreshed four material queries; Ninja checks used its existing
client/cache and durable attempt receipts.

- Normal base: first sorted page 100/156 raw offers, 85 verified sellers, cheapest 9 chaos.
- Rare target: 69 raw offers, 23 verified sellers, cheapest confirmed ask 813.6 chaos.
- Jagged method: 2068.1039 chaos expected cost; -1254.5039 chaos indicative spread; -60.659617% ROI.
- Magic target: empty complete search. Cost 117.956077 chaos; ask/profit/ROI unavailable.

These are dated asking prices, not completed sales or a trade recommendation.
The later REST smoke ran after target expiry and verified that stale cost/profit/ROI
were withheld. Captures are immutable; read/match views re-normalize original raw
Trade items without writing back or inventing absent legacy evidence.

## Browser QA

Actual desktop (1280x720 default) and 390x844 responsive browser runs:
search, category/tag filters, sort, both authored rows, sole-method detail,
Trade/CoE links, real ingredient/target art, actual rolled modifiers/tiers,
keyboard focus, Escape focus return, outside dismissal, tap previews,
right-edge clamp and overflow containment. Browser error log was empty.
Tooltip focus/scroll container and ARIA relationships were inspected; native
scrollbar dragging was not established by the DOM automation surface.

Screenshots: `desktop-list.png`, `desktop-detail.png`, `mobile-list.png`,
`mobile-detail-tooltip.png`, `mobile-listing-tooltip.png`.

Real VoiceOver speech validation was attempted through native computer use;
launch timed out (`timeoutReached`, -10005). ARIA/keyboard checks passed, but
this is not a completed VoiceOver test. Physical mobile and Safari were not run.

## Remaining limits and next action

- Owner reviews the draft; no automatic merge/deploy or Linear closure.
- Run real VoiceOver and physical/mobile browser acceptance before release.
- Source permissions must remain valid. Stop after challenge/access denial.
- Sorted-page ordering uses Trade's currency order; Ninja conversion is indicative.
- A batch exceeding source freshness windows withholds expired inputs. Receipt
  eviction or a cache hit without fresh HTTP proof also fails closed.
- CoE displays are rounded, patch-scoped evidence. Recheck mechanics after a patch.
- Existing orphaned running cycles and the 60-minute queue expiry remain lifecycle limits.

Only `.serena/` was pre-existing untracked metadata and remains outside the PR.
Related pre-existing UI edits were preserved in this implementation.

## Runtime cleanup

Owned API (3017), Vite (5177) and PostgreSQL (54326) were stopped and awaited.
The API logged graceful shutdown with no late pool errors; the owned ports have
no listeners. The isolated PostgreSQL data directory remains preserved at
`/tmp/worksmith-critical-pg17.MSsydj/data` for raw-evidence inspection.
No user stack on 3000/5173 or other PostgreSQL runtimes was stopped or modified.
Temporary QA/CoE tabs were closed. The next concrete action is owner review of
PR #26 and real VoiceOver acceptance, followed by a separately authorised release.
