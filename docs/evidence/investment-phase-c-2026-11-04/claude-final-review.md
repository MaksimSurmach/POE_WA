# Phase C — final independent Claude Code review

Reviewed runtime: `dd1229fdab503e069567270df8673b7a527596df`.
Session: `2d7dc10d-bf66-48dc-bbec-0ab989cf2f03`. Read-only code review; reviewer did not execute tests.

**Verdict: PASS.** R1 and R2 are closed, and I found no blocking regression. There is one non-blocking Low finding (R2 has a new-tab side effect) and two limits.

**Review head:** `dd1229fdab503e069567270df8673b7a527596df`, previous `349dee15a84b2971f8f67eeaf4e31c141d659f08`, one commit `dd1229f`. Uncommitted docs not reviewed. I did not run any tests.

## R1: closed

- **Dedicated stale signal.** `intelligenceRepository.ts:10-16,115` now throws `StaleIntelligenceEvaluation`, which is not a `DomainError`. Idempotency mismatches still throw `PERSISTENCE_CONFLICT` (409) from `findPlanRetry`/`savePlan`.
- **Whole-feed retry.** `intelligence.ts:532-543` retries the entire `feedOnce` up to 3 times. Each attempt builds a fresh context, and only a fully successful attempt is returned, so entries, candidates and settings from an older attempt are never mixed in.
- **Earlier writes are safe to redo.** Recipes already committed by a discarded attempt get stepped again with a later time. This cannot inflate confirmations, because a confirmation still needs a distinct observation ID plus the minimum gap.
- **End-of-pass checks.** `intelligence.ts:560-569`: if settings or the quote-age limit changed during the pass, the pass is discarded and retried. `decisionAt` is taken after evaluation, and the league window is checked again at that time.
- **Allocation uses the decision time.** `intelligence.ts:667` passes `now: decisionAt`. Quote expiry (via `analyzeOutcomeModel`) and listing expiry (via `holdingCapacity`) are therefore judged at the real decision time. The PG test covers the 2 h jump → HOLD.
- **Persistent contention.** After 3 failures it throws `INTELLIGENCE_RETRY_LATER`, which `api.ts:446` maps to 503 because its disposition is `retryable`. The PG test asserts exactly 3 attempts and a 503.
- **Worker.** `intelligence.ts:582-588` skips a stale recipe and continues its slice; other errors still propagate to `onError`.
- **Allocation retries.** A 503 saves no plan, so retrying with the same idempotency key recomputes the plan correctly.

## R2: closed, with one side effect

`IntelligencePanel.tsx:29` keys notices on the stored `lastEmittedAt`, so emissions made by the background worker now reach the UI. Duplicates are suppressed in memory and in `sessionStorage`, and the wording says "current state", which is accurate.

**Low (UX, no financial impact): a new tab re-announces old emissions.**
- **Where:** `IntelligencePanel.tsx:22-47`.
- **Cause:** `sessionStorage` is per tab, and `lastEmittedAt` is kept forever.
- **Repro:** open the catalog in a new tab. Every recipe that has ever emitted is announced as "signal update available", even if that emission was weeks old (shown as the first 3 plus "and N more").
- **Fix direction (optional):** announce only emissions after the session started or within a recency window, or use `localStorage`.

## Limits

- **A backwards stale check can block a recipe until time catches up.** The check at `intelligenceRepository.ts:105-115` also fires when the stored time is ahead of the current one. Two triggers: the wall clock stepping backwards, or a recipe's latest usable snapshot becoming older than the stored `observedAt`. Until real time or new evidence catches up, every feed that includes that recipe returns 503 after 3 retries, and the worker skips it silently. From the code, the snapshot case looks hard to reach, because raw snapshot rows are immutable and failed rows don't displace valid ones within the top-3 window. I have not ruled it out completely (for example, retention purges).
- **Test-only change.** The testkit clock change is test-only; I saw no production safeguard relaxed in this diff.
- **Not verified:** test results, worst-case latency of up to 3 full passes per request, live market data, trades, deployment.
