# Claude Code independent review

Session: `b0af19ff-e79d-4c05-8be5-045ba8dd5b7c`

# Phase B independent review: **FINDINGS**

Head reviewed: `8186ee4d87fb3a7225494deae7e29fce3beb1bf9` against base `e3557d7439035ce58b192905535f3788ef447d49`. I only read code. I did not run any tests or repro scripts. My shell access was denied, so I could not read the backend E2E log in `/tmp`, and its result is unverified.

No Critical or High findings. Two Medium findings should be fixed before Phase C.

## Medium

**M1. Realized ROI and profit per crafting hour leave out the cost of written-off items.**
`packages/domain/src/factoryLedger.ts:591, 708-716, 725-728, 741-744`; same pattern in `summarizeFactoryBatches` at `818-867`.
- Realized profit only covers sold items. Costs of discarded, recycled or consumed items go to `disposedCost`, which never reduces realized profit, ROI or profit per hour.
- Leaving a bricked item's cost unallocated makes ROI "Unavailable". Allocating it to a discarded item makes ROI look healthy instead.
- Repro: `golden()` plus `item-status discarded` for item `id(101)`.
  - Result: realized profit 33, ROI 194.12%, `allocationComplete` true, `disposedCost` 14.
  - The actual result after the write-off is 50 − 16 − 1 − 14 = 19.
- Fix: base ROI and profit per hour on realized profit minus `disposedCost`, with a denominator of `soldCost + fees + disposedCost`. Alternatively, return null for both whenever `disposedCost > 0`.

**M2. A salvage or manual outcome can carry the recipe's premium target signature.**
`factoryLedger.ts:468-473`
- The check only binds the signature when the declared outcome is `exact-target`. For a `manual` outcome, or one that isn't declared, the client-supplied `targetSignature` is accepted as is.
- Repro (with a forecast): the frozen model has outcome `brick`, classification `salvage`, matching `{kind:'manual'}`. Produce `{outcome:'brick', targetSignature: batch.targetSignature}`. It is accepted, and the sale row has `targetSignature = 'premium-exact'` with classification `salvage`.
- Repro (no forecast): produce `{classification:'salvage', targetSignature: batch.targetSignature}`. Also accepted.
- The UI checkbox "Matches this recipe's exact target" (`FactoryEventForm.tsx:217-232`) makes this a one-click mistake.
- Fix:
  - Reject a non-null `targetSignature` when the declared outcome's matching is `manual`.
  - Without a declared outcome, allow `targetSignature === batch.targetSignature` only for classification `premium` or `target`.
  - Reject it outright for `salvage`, `unusable` and `recovery`.

## Low

**L1. Some costs can never be fully allocated.** `factoryLedger.ts:410-414, 429, 447, 599, 636, 726, 742, 745`
- Cost amounts are kept exact (quantity × price × rate can have more than 16 decimals). Allocation amounts are capped at 16 decimals, and every completeness check uses exact `eq(0)`.
- Repro: purchase quantity 1, unit price `0.5` divine, rate `150.1234567890123457`. Consume 1, giving a cost of `75.06172839450617285`. Allocate the maximum `75.0617283945061728`.
  - `unallocatedCost` displays `'0'`, but `allocationComplete` is false. ROI shows "Unavailable" and the forecast can never become comparable.
- Fix: round cost amounts to 16 decimals when created, or compare the unallocated amount at the allocation scale.

**L2. A read can fail if a batch's start time is newer than the read clock.** `apps/server/src/repositories/factoryRepository.ts:36-45`
- `read()` sets "as of" to the later of the request clock and the event times, but not the batch's `startedAt`.
- Repro: the clock is read in `service.list`/`summary`, then a concurrent create commits before the repeatable-read snapshot (pool wait or clock skew between instances). The newer batch throws "Observation predates batch start", and that list or summary request returns 500.
- The existing test (`integration.test.ts:102`) only covers events newer than the read clock, not a newer `startedAt`.
- Fix: add `Date.parse(document.startedAt)` to the `Math.max`.

**L3. A pending request isn't cleared once the server has it.** `apps/web/src/FactoryPage.tsx:168-193, 264-279`; `factoryForm.ts:157-165`
- Repro:
  1. Submit an event; the commit succeeds but the response is lost.
  2. Refresh: the event now shows in history, but the pending request stays.
  3. Submit the same form again, meaning a second identical event (for example, consume 1 again). The fingerprint matches, so the old request is replayed and the UI says "Event recorded". No new event is created.
- Pending requests also survive definitive 400/409 errors, so an identical resubmission keeps its stale `expectedVersion` and conflicts every time. The UI message does warn about this.
- Fix: after loading the record, if `pendingEvent.request.event.id` is already in `record.events`, clear the pending request and tell the user it was already recorded. Clear the pending request on 400 `FACTORY_LEDGER_INVALID`.

**L4. Event timestamps are only checked per item.** `factoryLedger.ts:404-445, 462-508`
- These are all accepted:
  - consume before its purchase;
  - produce or allocate before the costs it references;
  - refund or return before its source event;
  - events after `cancelled`.
- These timestamps feed `producedAt` and therefore turnover.
- `startedAt` is set by the server at creation, so purchases made before the batch existed can't be recorded with their real time.
- Fix: require each event's `occurredAt` to be at or after the events it references. Optionally accept a client `startedAt` that is not in the future.

**L5. Turnover for a finished batch drifts forever.** `factoryLedger.ts:607-623, 746-753`
- The window always ends at "as of". After every item is sold, unit-seconds stop changing while the window keeps growing, so `observedUnitTurnover` rises without limit as time passes.
- Fix: end the window at the last terminal item status once no items are held.

**L6. Cash flow can't be reconciled from the displayed metrics.** `factoryLedger.ts:437-461`
- When refunds or non-recovery credits exist, nothing shows the refunded stock's cost basis or the "other" credits.
- Fix: add `refundedMaterialCost`, `refundReceipts` and `otherCredits` metrics.

**L7. The "attempts" hint contradicts the simulation's definition.** `FactoryEventForm.tsx:327-330`
- The hint says "terminal method runs, including internal retries". The simulation's method-run definition (`methodRunDefinition` in `craftingRisk.ts`) says internal stage retries are not separate runs.
- This undermines the equality check `attempts === objective.count`.
- Fix: reuse `methodRunDefinition` as the hint text.

## Checked and found correct (as read in code, not executed)
- **Currency and FX:** each transaction keeps its original currency and its locked rate. Chaos must have a rate of 1. JSON export keeps the rates.
- **Stock vs consumption:** stock is tracked per purchase lot. Returns can't strip already-allocated cost. Refunds are limited to unused stock.
- **Partial sales:** realized profit, unsold inventory cost, unused stock, cash flow and listing asks are kept separate. The golden numbers (33, 7, 14, 12, 43) check out by hand.
- **Corrections:** a void only removes an event's effects, and the full history is replayed. Voiding something another event depends on fails. Voids can't be voided.
- **Concurrency and idempotency:**
  - Appends lock the batch row and check the expected version, which serializes double consumption or sale.
  - The idempotency key lock and request hash cover the batch ID, expected version and event.
  - Reusing a key with a different payload conflicts. Item and event IDs are unique globally.
  - A replay returns the original version, and the UI fetches the latest record afterwards.
- **Phase A separation:** the forecast comparison needs a closed batch and a completed chaos simulation with a matching objective. The first-run expected value is explicitly excluded, so the two measures are not conflated.
- **Access and export:** every `/api/admin/factory/*` route, including GETs and export, requires local admin access and sends `no-store`. CSV cells that could run as formulas are neutralized, and the filename uses an ID already validated as a UUID.
- **Bounded reads:** summary, inventory and sales report whether they cover all batches. The summary is capped at 100 batches and flagged as partial beyond that.

**Verdict: FINDINGS** at `8186ee4d87fb3a7225494deae7e29fce3beb1bf9`. Fix M1 and M2 (and ideally L1–L3) before Phase C. This review is not deployment approval.
