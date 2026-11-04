# Phase C — second independent Claude Code review

Reviewed runtime: `349dee15a84b2971f8f67eeaf4e31c141d659f08`.
Session: `2d7dc10d-bf66-48dc-bbec-0ab989cf2f03`. Read-only code review; reviewer did not execute tests.

**Verdict: FINDINGS.** M1 and M2 are fixed, and I found no new math or data-integrity error. The fix for L4 introduced one Medium regression that fails safe, and the fix for L6 is only partly effective (one Low finding).

**Review head:** `349dee15a84b2971f8f67eeaf4e31c141d659f08`, prior `d3d3190e72ab74f7cdbf1d3075e6ce5490357091`, one commit `349dee1`. Uncommitted docs not reviewed. I did not run any tests.

## Prior findings: verification

| ID | Status | Basis |
|---|---|---|
| M1 | Fixed | `capitalAllocation.ts:237-259`: every option must meet the profit, ROI (against the guarded bankroll) and `maxLossProbability` thresholds. The exit band applies only when `signalConfirmsRiskOption` holds: state CRAFT, armed, same policy, same risk ID (`opportunitySignals.ts:193-212`). The new test at domain test diff line 137 covers the marginal older option. |
| M2 | Fixed | `factoryRepository.ts` `cohortEvidence`: repeatable-read, keyset paging by `b.id`, 50 per page. The SQL matches on the produce payload signature or the frozen exact outcome, which covers every case the ledger projection can produce. Results are then filtered by the actual item signature. Limit of 10k batches and 10k rows, with `complete=false` at the limit. Memoized per request context. Old unsold items are kept. |
| L1 | Fixed | `hysteresisArmed` requires `signalPolicyMatches` (`opportunitySignals.ts:235`). Any settings change disarms the exit band, which is conservative. |
| L2 | Accepted as designed | No change. The limitation is disclosed. |
| L3 | Fixed | Wording in `CapitalAllocator.tsx:109-126` and `CapitalFields.tsx:82-88` is accurate. |
| L4 | Fixed, with a regression | See R1. |
| L5 | Fixed | The history hash is (decision, previous history ID), and consecutive duplicates are skipped under the per-key lock. A→B→A is retained; the PG test covers it. |
| L6 | Partly fixed | See R2. |
| L7 | Fixed | Divine listings are converted with `convertMarketQuote`. The FX snapshot is checked by `verifyEconomySnapshot`, plus same league, `Currency` category, `currency-exchange` price basis, freshness, and \|verified − captured\| ≤ max quote age. Any other currency → partial. |

The additional QA fixes also check out:
- **Rounding guard:** correct under 8-decimal HALF_UP rounding. A cost sum of terms each with at most 8 decimals is exact, otherwise the +5e-9 guard bounds the true P95.
- **Reserve check:** reserve ≤ capital is compared in the same denomination, which the first refine already enforces.
- **PATCH override:** stops read defaults from becoming writes.
- **League window:** ended leagues are refused on the recommendation paths; `plan(id)` and idempotent allocation retries skip `context` and stay readable; `history` uses `allowHistorical`.

## New findings

**R1 (Medium, availability; fails safe, no wrong data): one out-of-order write aborts the whole list or allocation request.**
- **Where:** `intelligenceRepository.ts:99-108` throws `PERSISTENCE_CONFLICT`, and `intelligence.ts:529-541` (`feed`) does not catch it per recipe.
- **Repro:**
  1. A GET `/opportunities` takes `ctx.at=T1` and starts evaluating up to 50 recipes one by one.
  2. The 60 s background worker starts at T2 > T1 and commits recipe k (within its 10-recipe slice) before the GET reaches it.
  3. The GET's update for k sees stored `evaluatedAt=T2 > T1` → throws → the whole GET returns 409.
- The same applies to POST `/allocations`. It also reuses the idempotency-mismatch error code, so the UI cannot tell the two apart.
- This becomes likely once evaluations are slow (Factory replay, FX, up to 20 risk-run reads per recipe).
- **Fix direction:** per recipe, catch the conflict and return the newer stored view, or retry with a fresh context.

**R2 (Low): background-worker emissions never reach the UI.**
- **Where:** `IntelligencePanel.tsx:20-47` together with `intelligence.ts` `evaluate`.
- **Cause:** every GET steps the signal again before returning. A no-change step has `emit=false` and overwrites the worker's `emit=true`.
- **Repro:** the worker moves WATCH→CRAFT at T1 with `emit=true`. The user loads at T2, the GET re-step returns `emit=false`, and no notice appears. Only transitions computed during the user's own request are announced. History still records the transition.

## Nits

- `allocateCapital` ROI uses the guarded bankroll while the signal ROI uses the raw P95. The difference is at most 5e-9 in the denominator; conservative.
- Worst-case per-request work: up to 50 recipes × (1 + 8 extra cohorts), each paging every league batch through JSON `exists` subqueries plus replays. It is bounded but can be slow, which raises the chance of R1.
- On an ended current league, the worker logs `INTELLIGENCE_LEAGUE_INACTIVE` every 60 s.

## Limitations

- Static read only; no tests or builds executed.
- Not verified:
  - `convertMarketQuote` internals (its decimal output must stay within 48 decimal places, otherwise the snapshot is silently dropped, which fails safe);
  - the HTTP status mapped to `INTELLIGENCE_LEAGUE_INACTIVE`;
  - query plans and index use for the cohort SQL.
- No live market data, trades or deployment checked.
