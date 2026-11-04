# Claude Code final addendum

# Phase B addendum review at `addbab036b65719e218a02ba4f7052f6c5287497`: **PASS**

I reviewed the diff from my previous PASS head (`99ebbd2`) to this head. All three Low findings are fixed. The fix for the first one adds one new Low issue: an explanation text is wrong, but no numbers are affected.

## The three fixes, rechecked
1. **Forecast made after a backdated start.**
   - `factoryLedger.ts:755-759` now blocks comparison when the forecast's `analysisInput.now` is later than `batch.startedAt`. The check is strict, so a forecast made at exactly the start time still compares.
   - The expected cost and profit become null, and the reason text explains why (`:877-879`).
   - The existing comparable tests now set `input.now = at(4)`, which equals `startedAt`, so they are still valid. Fixed.
2. **Tiny allocations.**
   - `FactoryEventForm.tsx:69` now has `min="0"`.
   - A zero amount is still rejected before sending, because the allocation schema requires a value above zero and `buildFactoryEvent` parses the event. The server checks the same thing.
   - The unused `AllocationFields` props were removed. Fixed.
3. **Conflict recovery without browser storage.**
   - `attemptedRequest` is set before the network call and preferred on a 409 (`FactoryPage.tsx:292-293, 314, 340-344`). `sessionStorage` is now only a fallback.
   - Errors thrown before that assignment are never `ApiClientError`, so they can't take the 409 path. Fixed.

## New finding (Low, not blocking)
**Normal batches without a risk run now show the wrong "unavailable" reason.** `factoryLedger.ts:755-757, 877-879`, combined with `apps/server/src/factory.ts` (create path) and `craftAnalysis.ts:339`.
- `create()` captures `recordedAt` (which becomes `startedAt`) before it calls `readAnalysis`. `readAnalysis` stamps `evaluatedAt` with a fresh clock read, so it always lands a few milliseconds later.
- A batch with no linked risk run uses that first-run analysis as its forecast. Almost always, `analysisInput.now > startedAt`, so `retrospectiveForecast` is true.
- The comparison is unavailable anyway because there is no risk run, so no numbers change. But the reason text says "Forecast was created after the batch started; retrospective…" instead of the real reason ("…First-run cash EV is not a batch forecast"). The UI shows this text at `FactorySummary.tsx:195`.
- Batches linked to a risk run are not affected: their `analysisInput` is `risk.request.analysis`, which was created before the batch.
- Fix: count a forecast as retrospective only when a risk run is attached (`risk && Date.parse(...) > ...`), or check the general unavailable conditions before the retrospective one when choosing the reason.

## Limitations
- This was a read-only review of the diff and the lines it touches. I did not run any tests, browsers, PostgreSQL or E2E.
- All validation results (152 PostgreSQL cases, 8 backend E2E, 6 browser scenarios, unit/contracts/build/typecheck/lint, and the focused tests after this change) are the implementer's claims, not verified by me.
- I did not re-review code outside this diff beyond my previous PASS at `99ebbd2`.
- Batch creation is unchanged and still relies on an exact retry of the pending request; I did not infer anything from matching the batch list.
- This is not a merge or deployment approval.

## Implementer follow-up

The remaining low wording issue was corrected by requiring an attached risk result before calling a forecast retrospective; the same regression now verifies the missing-risk explanation. This two-line behavior correction was not independently re-reviewed.
