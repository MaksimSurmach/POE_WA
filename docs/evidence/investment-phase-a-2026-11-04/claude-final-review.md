# Claude Code independent re-review

Session: `3f510ee6-e117-4ca0-9805-ca63e36f179e`

**Verdict: PASS.** All five findings are resolved at code head `99f51b54084ad7b95db7249bc7ec8f11f6aa6116`, compared against `e7e63a6`. I found no material residual defects. The code is ready as the base for Phase B; this is not deployment approval.

I did not run any tests or scripts. Every conclusion below comes from reading `git diff e7e63a6 99f51b5` and the pinned files. The passing test results in your message are as reported to me.

## The five initial findings
| # | Status | Basis |
|---|---|---|
| 1. Shortcut used the wrong success probability | Fixed | `craftingRisk.ts`: the shortcut now requires exactly one positive-probability `targetSuccess` outcome, and it must be sellable. Every other case goes to Monte Carlo. |
| 2. Reused vs consumed base | Resolved by labelling (accepted) | See the assessment below. |
| 3. Valid models crashed the shortcut | Fixed | `geometricInputSchema.safeParse` falls back to Monte Carlo when inputs fail. The regression test uses 0.1234567890123456², which has 32 decimal places, and expects a Monte Carlo result. |
| 4. Target outcome not tied to the recipe target | Fixed | Mismatches are rejected both when saving (`craftAnalysis.ts`) and in `validateRecipeDocument`. A salvage outcome may still use another item's signature, and an outcome matched by manual description cannot take market prices. |
| 5. Purchase prices shown as "0 sellers" | Fixed | Seller count is now `null` for purchase prices. A resale price with `null` fails closed with "insufficient independent sellers". The UI shows the seller count only for resale quotes and shows "unknown" when it is `null`. |

## Finding 2: do the labels honestly describe what is computed?
Yes.
- **Contract:** `valueBasis: 'cash-proceeds-minus-gross-outlay'`, `horizon: 'one-method-run-with-setup'` and `unvaluedRetainedBaseProbability` together describe the horizon exactly.
- **Retained-base probability:** it counts every terminal outcome marked `retained`, whether the base was bought as setup or inside a stage.
- **Panel headline labels:** "Initial run outlay", "Net cash EV", "Expected cash ROI" and "Break-even target resale (initial run)".
- **Warning:** a warning appears whenever the retained-base probability is above 0.
- **Simulation panel:** it says its results cover the selected objective, not the initial-run EV.
- **Phase B:** the contract exposes the fields it needs to exclude first-run results that leave assets unvalued. The planned rule must be enforced in Phase B; nothing in this code enforces it yet.

## Other changes in this range
- **Worst-5% average:** the new calculation is correct for any trial count. For 101 trials the tail covers 5.05 trials, so it averages the 5 worst plus 0.05 of the next one. The expected 100/5.05 = 19.8019802 in the test is right. The analytical shortcut's formula is unchanged and consistent with it.
- **Renamed field:** `atLeastOneTargetWithinRunsProbability` (first target within N runs, not completion of the objective) matches the formula. The UI label was updated to say "first target".
- **Embedded model:** it is passed to the existing explicit owner-save editor with empty prices and valuations. Analysis stays unavailable until the owner saves a revision with prices. No recipe in the repository currently contains an embedded `outcomeModel`, so no probabilities are invented for existing recipes.

## Non-blocking low issue
- **Calculation version not bumped:**
  - **What changed:** `outcomeCalculationVersion` is still `'outcomes-1'`. The stored simulation result format changed underneath it: `valueBasis` is now required and `targetWithinRunsProbability` was renamed. The worst-5% values and the shortcut eligibility also changed for some inputs.
  - **Effect:** in any database holding a completed run from `e7e63a6`, `runRecord` fails to parse it under the strict schema. Reading that simulation, or replaying its idempotency key, then returns an error. Results computed under the old rules cannot be told apart from new ones by version.
  - **Impact today:** none in production, since Phase A was never deployed. Only local test and dev databases are affected.
  - **Fix:** bump to `outcomes-2` before any persistent database stores runs, or confirm that no old runs exist outside test databases.

## Small discrepancy in your summary
The finding-1 regression test does not check "mean ≈20 / profit 30". Its non-sellable target has p=0.75, so it asserts `meanCost` 12 and `meanMethodRuns` 1 under Monte Carlo. That still proves the fallback.

## Scope
- **Reviewed head:** `99f51b54084ad7b95db7249bc7ec8f11f6aa6116`.
- **Not reviewed:** the uncommitted evidence files (README, PNGs, `synthetic-simulations.json`, `claude-initial-review.md`), the planning doc, and the full bodies of the server, API and web test files.
