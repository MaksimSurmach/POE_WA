# Worksmith investment and production readiness

This initiative extends the existing single-method recipe catalog, market snapshot pipeline, PostgreSQL backend and React application. It does not execute trades or introduce another market engine.

## Pull-request stack

| Phase | Reviewable change | Dependency | Status |
| --- | --- | --- | --- |
| A | [PR31](https://github.com/MaksimSurmach/POE_WA/pull/31): outcome EV, salvage and reproducible risk | master7387f7c / merged PR30 | Draft; Claude PASS; CI109 passed |
| B | [PR32](https://github.com/MaksimSurmach/POE_WA/pull/32): Factory ledger, inventory and sales | PR31 | Draft; Claude PASS; CI110 passed |
| C | [PR33](https://github.com/MaksimSurmach/POE_WA/pull/33): signals, liquidity and capital allocation | PR32 | Draft; Claude PASS atdd1229f; all local gates passed; CI tracked on PR33 |

No PR has been merged or deployed by this initiative. The installed application and its database were not migrated or replaced.

## Working journeys

1. Open a recipe, define or save a complete sourced outcome model, inspect cash EV/salvage and simulate a method-run or target-success objective. Missing inputs remain explicitly unavailable.
2. Start a recipe-bound Factory batch, record purchases and consumption, allocate costs to outcomes, list items and confirm actual sales. Corrections preserve original events. Realized sold-item profit, disposed-item result, cash flow and unsold stock remain separate.
3. Inspect exact-target signals, asking-supply proxies and confirmed own-sale/holding evidence. Enter capital and reserve with an explicit conversion source; obtain a whole-objective advisory plan or a reasoned watchlist/hold result. Saved plans retain their original evidence.

One recipe remains one exact target plus one method. Outcome branches are results of that method, not alternative recipe variants.

## Persistence and API

Forward migrations0025–0027 add immutable outcome models/risk results, Factory batches/events/idempotency records, signal state/history and saved allocation plans. Each preservation rehearsal used PostgreSQL17 on an isolated local test database; existing table contents were compared by row counts and content digests. Production and installed local data were untouched.

Main endpoints:

- Recipe analysis: `/api/recipes/:recipeId/analysis`.
- Owner model and simulation lifecycle: `/api/admin/craft-analysis/*`.
- Owner batches, events, inventory, sales, summary and export: `/api/admin/factory/*`.
- Owner opportunities, recipe liquidity/history and saved allocation plans: `/api/admin/intelligence/*`.
- Signal/allocation policy: the existing `/api/admin/market/settings`.

Financial/inventory mutations serialize and reject duplicate/conflicting requests. Original currencies and transaction-time rates are preserved. Current exchange-rate changes never rewrite realized Factory profit. Private records are not exposed through public endpoints.

## Evidence and review

- [Phase A numerical/browser/migration evidence and Claude receipts](investment-phase-a-2026-11-04/README.md).
- [Phase B accounting/browser/migration evidence and Claude receipts](investment-phase-b-2026-11-04/README.md).
- [Phase C intelligence/browser/migration evidence and review](investment-phase-c-2026-11-04/README.md).
- [Factory desktop](investment-phase-b-2026-11-04/desktop.png), [Factory mobile](investment-phase-b-2026-11-04/mobile.png), [production plan desktop](investment-phase-c-2026-11-04/desktop.png), [production plan mobile](investment-phase-c-2026-11-04/mobile.png).

Final integrated local validation atdd1229f:173 domain,21 contract,125 web and467 server unit tests;7 provider contracts;161 PostgreSQL integration checks;8 backend E2E and8 Chromium desktop/mobile browser scenarios. Build, typecheck and lint passed. Migration0027 preserved all34 prior tables. No material Claude findings remain.

All browser acceptance prices, probabilities, transactions and sales are labelled synthetic scenarios. They verify application behavior; they do not establish a live profitable craft. Claude reviews are independent code reviews, not executed test results or GitHub approval votes.

## Release boundaries

- Existing recipes do not gain invented outcome probabilities. A complete sourced model is required for EV/risk; insufficient market or liquidity evidence cannot produce an allocation.
- Initial-run cash EV excludes retained assets and is labelled separately from target-success/batch distributions. Unsupported probability/valuation ranges and censored simulations cannot become precise risk claims.
- Production recommendations require supported fresh resale observations. Entered resale assumptions and individual historical transactions do not become current market quotations.
- Allocation uses stored whole simulation objectives and exact own holding-time samples. It does not multiply per-item P95, infer sales from missing listings, or claim a globally optimal portfolio.
- Modelled loss/bankroll bounds assume the declared outcome model and stored sale valuations. Unsold inventory within the horizon, price movement and liquidation risk are not included in those probabilities.
- Factory responses and computation have explicit resource/coverage limits. Intelligence uses paged exact cohorts rather than the Factory summary cap. See phase evidence for current bounds and unsupported objectives.
- Per-session local notification deduplication can repeat an old notice in a new tab. Backwards clocks can temporarily return retryable503. Worst-case cohort-limit latency was not load-tested; freshness and monetary integrity remain fail closed.
- Workbook import, real game transactions, live-market profitability validation, Safari/physical devices and screen-reader speech were not tested or implemented where optional. The existing web bundle-size warning remains.

Release sequence, if separately authorized: merge the dependent stack in order A→B→C, apply forward migrations through the existing deployment path, and verify the actual league/provider evidence before using any green recommendation. Passing synthetic acceptance does not validate the current economy or owner-entered assumptions.
