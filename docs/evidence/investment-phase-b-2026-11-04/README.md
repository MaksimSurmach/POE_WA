# Phase B — production and sales acceptance

Base: Phase A PR31, `e3557d7`. Initial review: `8186ee4`; material corrections reviewed PASS at `99ebbd2`; final low-severity corrections: `addbab0`. No merge, deployment or installed-database changes.

## Working behavior

My Factory creates a recipe/revision/league-bound batch with an immutable forecast/evidence snapshot where available. Purchases retain original quantity, price, currency, conversion and source; consumption moves only used resources into production cost. Items retain traced cost allocations, classification and their actual output signature, separately from the owning recipe target.

The append-only log supports purchases, consumption, material returns/refunds, expenses, recovery credits, produced items, allocations, listings, confirmed sales/fees, activity, status, notes and audited corrections. Corrections preserve the original event and reject histories whose dependent records no longer reconcile. Repricing preserves listing age. Completing production does not mark remaining items sold.

Realized sold-item profit, cash flow, unsold item cost, unused materials, gross spending, production cost and unallocated/disposed costs remain distinct. Recognized item result additionally subtracts disposed-item costs; ROI includes sold/disposed costs and sale fees. Recovery credits, refunds and other credits are separate cash receipts. Confirmed sale timing and time-weighted unit turnover include their sample/window; listing asks are explicitly indicative, not confirmed revenue or fair value. Forecast comparisons require the frozen simulation's matching objective, a completed allocated batch and no remaining unvalued stock/assets; first-run cash EV is never treated as a batch forecast.

All factory reads, writes and exports use the existing owner-only admin guard. Mutations use UUID idempotency and canonical request hashes, batch row locks and deterministic replay. The UI preserves the exact pending request after unknown network outcomes, including its timestamp, version and FX, then reloads current state after success. Reload reconciles already-committed pending requests before accepting a new intentional identical transaction. Historical starts and dependency timestamps are validated; completed batches can liquidate stock but must reopen for new production. Exact allocations preserve up to48 decimal places from transaction products. JSON retains context/history; CSV quotes cells and neutralizes spreadsheet formulas.

## Verified behavior

- Golden numerical cases: partial sales, fixed transaction FX, unused stock, returns/refunds, recovery credits, allocation limits, duplicate sale, corrections/replay, rounding, actual-output signatures, salvage classification, lifecycle chronology, sale timing and common-window turnover aggregation.
- PostgreSQL/API: concurrent duplicate requests and conflicting keys, negative stock/overallocation/duplicate-sale rejection, correction/restart integrity, read-clock races, immutable forecast evidence, cross-league forecast rejection and private access/export.
- Desktop and mobile browser acceptance creates a real API-backed synthetic batch, loses an already-committed purchase response, retries without a duplicate, consumes materials, registers target/salvage items, allocates finishing, confirms a divine-denominated sale, corrects/replaces that sale and exports/reloads the immutable history.
- The synthetic batch spends20c on10 essences and20c on2 bases; consumes4 essences plus2 bases; allocates14c to each of2 items; finishes the target for2c; sells it for0.5div at the recorded100c/div rate and pays1c sale expense. Final values: realized profit33c, cash flow7c, unsold inventory14c, unused materials12c, production cost30c, gross spending43c. These are acceptance fixtures, not actual game transactions.
- Full unit/contracts, PostgreSQL integration, backend E2E, build/typecheck/lint and migration validation passed. All6 browser tests across Phases A/B passed after review fixes; PostgreSQL integration152 and backend E2E8 passed. Existing web bundle-size warning remains.
- Migration0026 preserved all31 previous table row counts/content digests on a separate PostgreSQL17 copy, including Phase A persisted records. Added only factory_batches, factory_events and factory_mutations. See [migration receipt](migration-preservation.json).

[Desktop screenshot](desktop.png) · [Mobile screenshot](mobile.png) · [Synthetic original batch/event records](synthetic-ledger.json).

## Bounds and limitations

Accounting currency is chaos; original chaos/divine transaction currencies and explicit historical conversion remain intact. Batches are bounded to2000 events and1000 produced items. League summaries cover at most100 batches and explicitly report incomplete coverage; listings/inventory/sales have bounded pagination. One transaction-expense entry is exposed per sale in the compact UI; the API supports multiple. Corrections require dependent sales/allocations to be corrected first. No external workbook import, live purchases, actual game sales or production migration was performed. Safari/physical devices and screen-reader speech were not tested; Chromium desktop/mobile viewports were tested.

## Independent review corrections

Claude initial review found two medium and seven low issues. Corrections cover disposed-cost ROI, exact outcome signatures, allocation precision, read clocks, network reconciliation, historical chronology, closed-batch policy, turnover windows, refund reconciliation and method-run wording. See [initial review](claude-initial-review.md). See [re-review PASS](claude-final-review.md). A final narrow addendum reviews the retrospective-forecast guard, tiny allocations and in-memory conflict recovery. Reviewer read code; implementer executed tests.

Retrospective forecasts created after a historical batch start cannot measure forecast accuracy. Unknown batch-creation responses remain recoverable by retrying the exact pending request; the UI never guesses identity from identical batch attributes.
