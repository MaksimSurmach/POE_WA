# Claude Code independent re-review

Session: `b0af19ff-e79d-4c05-8be5-045ba8dd5b7c`

# Phase B re-review at `99ebbd2535a6898ca422036296a4d41696b8795e`: **PASS** (no material findings)

I compared this head against the previous one (`8186ee4`) and read the code at head; Phase A base is `e3557d7`. All my earlier findings (M1, M2, L1–L7) are fixed in the code. The corrections introduce no Medium or higher issues. Three new Low findings are below; none of them block Phase C.

## Earlier findings, rechecked

| ID | Status | What I checked |
|---|---|---|
| M1 | Fixed | `factoryLedger.ts`: recognized item result = realized profit − disposed cost. ROI = recognized ÷ (sold cost + fees + disposed cost). Profit per hour uses the recognized result. The league summary uses the same denominator. My golden + discard case now gives recognized 19 and ROI 19/31 = 61.29%. Sold-only realized profit stays 33. |
| M2 | Fixed | The server rejects a manual outcome that claims any signature. An undeclared outcome can use the recipe signature only as `target` or `premium`. The UI checkbox is gated by the same rule (`factoryExactTargetAllowed`). |
| L1 | Fixed | Allocations now accept up to 48 decimals and values up to 1e36, which covers quantity × price × rate (16+16+16 decimals, each input ≤1e12). The lot unit cost is exactly price × rate. Every cost path (consume, return, expense) stays within 48 decimals, so the exact `eq(0)` checks can be satisfied. |
| L2 | Fixed | `read()` now takes the latest of the read clock, the batch `startedAt` and the latest event time. The summary's as-of time does the same. |
| L3 | Fixed | A reload clears a pending event whose ID is already recorded. A 400 `FACTORY_LEDGER_INVALID` clears the pending request; I confirmed this can't hide a committed write, because a replay is checked before the ledger is projected. A 409 marks the request, and only an explicit refresh clears it. Unknown outcomes are kept. The status codes map as expected (`api.ts:431-442`). |
| L4 | Fixed | Consume, refund and return can't predate their source. Allocations can't predate the item or the cost. Batch status changes must move forward in time. Once a batch is not active, purchase, consume, produce and activity are blocked until it is reopened. Historical starts are accepted only if not in the future, and they are part of the idempotency hash. |
| L5 | Fixed | When the batch is not active and every item is closed out, turnover ends at the later of `completedAt` and the last item status change. |
| L6 | Fixed | Refund receipts, refunded cost basis and other credits are now shown. I re-derived the reconciliation: cash = realized − inventory − disposed − unallocated − unused stock − refunded cost + refunds + recovery + other credits. It holds. |
| L7 | Fixed | The hint text now reuses the shared method-run definition. |

**Comparing until-target forecasts for reusable bases (new behaviour):** this is sound under the simulation's rules.
- A trial that isn't censored always ends on a target outcome that consumes its base.
- Retained bases from runs that don't hit the target are reused, not left over.
- Censored runs make the risk result unavailable (`craftingRisk.ts:391`), and comparison requires a complete result.
- `attempts` objectives are still excluded.

## New findings (Low, not blocking)

1. **A backdated batch can be compared against a forecast made afterwards.** `factoryLedger.ts:752-763`
   - Repro: create a batch with `startedAt` 2026-10-01 and a linked risk run evaluated 2026-11-04, then close it. The comparison reads "comparable" even though the "expected" prices were observed after production.
   - Fix: require `forecast.analysisInput.now <= batch.startedAt` for comparison, or label the comparison as retrospective.
2. **The UI can't allocate a leftover cost below 0.000001 chaos.** `FactoryEventForm.tsx:71` has `min="0.000001"` on the allocation amount.
   - The server accepts it, but the browser's own form validation blocks submitting such a residue. That can happen after a rounded partial allocation.
   - Fix: change to `min="0"` (the server already enforces > 0), or add an "allocate remaining" option.
3. **The 409 handling depends on browser storage.** `FactoryPage.tsx:337` rebuilds the rejected-conflict mark from `sessionStorage` instead of the in-memory pending request. If storage is unavailable, the mark is never set, so resubmitting the identical form keeps returning 409. There is no risk to the data.

**Not changed, informational:** a pending batch creation is still not reconciled against the batch list. An intentional second identical batch after a lost response would replay the first one. This is rare.

## Limitations
- This was a read-only review of the code at head. I did not run any tests, the browser scenarios, PostgreSQL integration or backend E2E. All pass results are the implementer's claims and I did not verify them.
- My shell access was denied, so I could not read the `/tmp` backend E2E log, and the full PostgreSQL/backend rerun result is unknown to me.
- I did not check in a browser that number inputs preserve 48-decimal values.
- I did not write the review receipt file, because this review was read-only; your initial receipt (`docs/evidence/investment-phase-b-2026-11-04/claude-initial-review.md`) is unchanged.
- This is not a merge or deployment approval.
