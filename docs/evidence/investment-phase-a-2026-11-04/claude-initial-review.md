# Claude Code independent review

Session: `3f510ee6-e117-4ca0-9805-ca63e36f179e`

**Verdict: FINDINGS.** I found two medium and three low-severity bugs at `e7e63a6`. The scope notes at the end cover what I could not run or did not review.

## Findings

### 1. Medium: the analytical shortcut uses the wrong success probability
- **Where:** `packages/domain/src/craftingRisk.ts:458-466`
- **Cause:** `successes` only keeps outcomes that are both `targetSuccess` and `sellable`. The rejection check only looks at outcomes where `!o.targetSuccess`. So a target outcome that is not sellable passes the check. It is then ignored when computing `p`, its costs, and its revenue. The Monte Carlo path does count it, because it increments `successes` on `targetSuccess` (line 344).
- **Repro:** use the advanced JSON editor or the API with one stage, a stage cost of 10, and the objective `single-target`:
  - A: target, sellable, p=0.25, valued at 100
  - B: target, not sellable, p=0.25
  - C: failure, p=0.5, no costs
- **Result:** the shortcut returns `meanCost` 40, `meanMethodRuns` 4 and `meanProfit` 60. The correct values are 20, 2 and 30. The output is labelled "Exact geometric analysis" with `percentileRankError95: 0`.
- **Reach:** the guided editor cannot trigger this, because it always attaches costs to every outcome, which sends it to Monte Carlo. The advanced editor and the API can.
- **Fix:** only take the shortcut when there is exactly one `targetSuccess` outcome and it is sellable. Otherwise return `null` and fall back to Monte Carlo.

### 2. Medium: EV, ROI and break-even ignore whether the base is reused or consumed
- **Where:** `packages/domain/src/outcomeEconomics.ts:271-291` and `:385-392`
- **Cause:** `analyzeOutcomeModel` never reads `baseDisposition`. The initial base is charged in full on every run, and a retained base gets no credit.
- **Repro:** use the `syntheticGeometricInput(true)` fixture (base 10 bought once, material 2 per run, p=0.25, target worth 100, reusable base).
  - The EV panel shows a cost of 12 per run and a break-even target resale of 48.
  - The risk panel, on the same model, shows a mean cost of 18 per target, so break-even should be 18.
  - The consumed-base variant gives identical EV numbers. "Expected bases consumed" shows 1 even when the base is retained.
- **Impact:** the panel understates the profitability of reusable-base crafts and contradicts the risk results shown next to it.
- **Fix:** for each terminal outcome with `retained`, credit p × the initial base cost as a labelled retained-base value. This brings the per-run cost to stage cost + base × P(consumed), which matches the Monte Carlo renewal cost. Also fix `expectedBaseConsumption` the same way. Alternatively, define EV per target instead of per run.

### 3. Low: valid models can crash the analytical shortcut
- **Where:** `craftingRisk.ts:489-496`, together with the schema at `:140-149`
- **Cause:** `unit.toFixed()` and `setup.toFixed()` are products of quantity × price. They can have more than 16 decimal places, but `geometricInputSchema` rejects anything longer than 16.
- **Repro:** a stage cost with quantity `1.5` of a resource priced `0.3333333333333333` (both valid) gives a unit cost of `0.49999999999999995`. That throws a `ZodError`, and the worker marks the job `failed` ("Simulation failed…").
- **Impact:** no wrong number is published, but a valid model cannot be simulated.
- **Fix:** pass `Decimal` values to the analytical function internally, or fall back to Monte Carlo when the amounts fail `isOutcomeAmount`.

### 4. Low: a target outcome is not tied to the recipe's exact target
- **Where:** `apps/server/src/craftAnalysis.ts:354-378`
- **Cause:** `saveModel` does not check that a `targetSuccess` outcome with `matching.kind === 'exact-target'` uses the recipe's `definition.targetSignature`.
- **Impact:** an outcome matching a different item's signature can be marked as the target. `resolveCraftAnalysisEvidence` then attaches that other recipe's market valuation, and the outcome counts toward "target probability" and the `single-target` and `successes` objectives. This weakens the "one recipe, one exact target" invariant.
- **Fix:** reject the mismatch at save time.

### 5. Low: market purchase prices are shown as having 0 sellers
- **Where:** `craftAnalysis.ts:133`
- **Cause:** market purchase prices get a hard-coded `independentSellers: 0`, and `CraftRiskSummary` displays it as "0 sellers".
- **Fix:** carry the real deduplicated seller count, or leave the field out of the display for purchase quotes.

## Checked, no defect found
- **Probability and graph math:** stage normalization and the explicit unknown residual; the absorbing-chain solve and its non-absorption/singularity handling.
- **Cost accounting:** credit and salvage accounting (salvage is a subset of resale, so it is not double-counted); finishing costs counted once on the transition.
- **Analytical formulas:** geometric quantiles, P(over budget), P(loss), the two expected-shortfall formulas, and profit quantiles.
- **Simulation sampling and bounds:** 64-bit sampling resolution, the DKW bound, base replacement (not charged after the final target), and censoring giving an unavailable result.
- **Persistence and concurrency:** idempotency and revision handling under the advisory lock plus unique indexes; the queue cap; cancel-versus-finish races (atomic `CASE`); restart sweep (marks jobs interrupted, does not requeue).
- **Access control:** admin access is loopback-only with Origin and Sec-Fetch-Site checks; `/api/admin/` is now gated as a prefix; saving models rejects market-observation quotes.
- **Evidence handling:** market valuations need complete coverage and ≥2 deduplicated sellers.

## Scope
- **Reviewed:** `git diff 7387f7ce60539eea1a4453e51f9c064cf158360d e7e63a6` and `docs/evidence/investment-phase-a-2026-11-04/README.md`.
- **Head moved:** HEAD moved to `954cc84` during the review. That commit only adds docs (the README, evidence files and a plan) and I did not review it beyond the README.
- **Concurrent edits:** someone else is editing the working tree. There are uncommitted changes to `craftingRisk.ts`, `outcomeEconomics.ts`, `CraftRiskSection.tsx`, `CraftRiskSummary.tsx` and two test files. I did not review them; line numbers above refer to `e7e63a6`.
- **Not executed:** I was not allowed to run my repro script, so every finding comes from reading the code. I did not run any tests, and the passing test results in the README are as reported.
- **Not reviewed in depth:** `0025_snapshot.json`, the testkit, the test files, CSS, the browser spec, and the evidence JSON and PNG files.
