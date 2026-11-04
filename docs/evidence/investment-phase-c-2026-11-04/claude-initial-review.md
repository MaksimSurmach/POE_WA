# Claude Code independent Phase C review

Session: `2d7dc10d-bf66-48dc-bbec-0ab989cf2f03`

**Verdict: FINDINGS.** I found no math or data-integrity error that would make an allocation unsafe. I found two Medium issues: one bypasses the signal's entry thresholds, the other is a functional dead end.

**Review head:** `d3d3190e72ab74f7cdbf1d3075e6ce5490357091`, base `61b47f4b19bad6f8c8dd99e6b71adcf707ce6dd8`. Committed code only; the untracked browser spec and docs/evidence were not reviewed.

## Material findings

**M1 (Medium): allocation can pick a saved simulation that never passed the signal's entry thresholds.**
- **Where:** `apps/server/src/intelligence.ts:299` and `packages/domain/src/capitalAllocation.ts:130-250`.
- **Cause:** the signal is computed from only `riskOptions[0]`, the most recently finished run. The allocator then accepts any of the up to 20 matching options once `signal.state === 'CRAFT'`. It does not re-check `enterProfitChaos`, `enterRiskAdjustedRoiPercent` or `maxLossProbability` for the option it actually picks.
- **Repro:**
  - Run A (latest): 10 attempts, profit 50, ROI 20%, P(loss) 0.1. Signal reaches CRAFT.
  - Run B (older): 1 attempt, profit 0.5, ROI 1%, P(loss) 0.4.
  - Request with `maxRiskProbability=1` and capital where only B's P95 fits.
  - The plan line uses B and is labelled as fitting a CRAFT opportunity, although B fails all three entry thresholds.
- **Fix direction:** in the allocator, apply the signal thresholds to each option, or allow only `signal`'s risk ID.

**M2 (Medium, fails closed but blocks the feature): more than 100 Factory batches in a league puts every plan permanently on HOLD.**
- **Where:** `apps/server/src/intelligence.ts:100,108` → `capitalAllocation.ts:55`.
- **Cause:** `factory.list(league, at, 100, 0)` returns the 100 newest batches, and `ownComplete = total <= 100`. From the 101st batch, `ownCoverageComplete=false` for every cohort, so every option is rejected with "Own factory observations are incomplete".
- **Repro:** create 101 batches in one league, then POST an allocation. Every scenario returns `hold`.

## Low / design confirmations needed

- **L1 – Exit band survives a settings or risk change.** `opportunitySignals.ts:265-270,403-405` choose thresholds from `prior.hysteresisArmed`, not from `confirmationPrior`. Confirmations reset, but after raising `enterProfitChaos` to 100, an armed recipe with profit 50 returns to CRAFT after 2 new observations. The test at `intelligence.test.ts:414` covers this deliberately for changed math, so it is intended. Confirm the same is wanted for a tightened policy.
- **L2 – Sale-price quote may come from an older snapshot.** `saleableCohortIssues` (`opportunitySignals.ts:156-165`) checks the quote reference against any of the up to 3 stored snapshot IDs (`evidenceIds`), not the latest. The cap is only "≤ latest median ask" plus the quote's own expiry. This is acceptable but weaker than "prices come from the snapshot used for liquidity".
- **L3 – The union risk bound covers cash loss and P95 overrun only.** It assumes every output sells at the quote's minimum value. Not selling within the horizon is outside the bound; only the 75th-percentile holding time vs the horizon is gated. The limitations text says "conditional on the declared model", which is accurate, but "Cash loss ≤ X%" in `CapitalAllocator.tsx:158` reads stronger than that.
- **L4 – Concurrent evaluations can overwrite newer state with older evidence.** The evidence and `ctx.at` are computed outside the per-key lock (`intelligence.ts:291-370`). A slower request started earlier can commit after a newer one, so `evaluatedAt` goes backwards and the state may flip spuriously. Confirmations are not inflated, because the independence check rejects older observations.
- **L5 – History can drop a return to an earlier state.** `craft_signal_history` is unique on (context, evidence_hash), so an A→B→A sequence with an identical hash is not re-recorded. The history is not a strict append-only log.
- **L6 – Signal cooldown has no effect.** `emit` and `lastEmittedAt` are computed but nothing consumes them; history records every new evidence hash regardless.
- **L7 – Any matching divine-priced listing makes the cohort partial** (`intelligence.ts:160-200`). High-value cohorts therefore never reach "supported". Combined with the default 3600 s maximum snapshot age and 2 required confirmations, refresh timing must produce 2 fresh complete snapshots within an hour.

## Nits

- `apps/server/src/intelligence.ts:38` duplicates the domain's `intelligenceMonetaryFingerprint` with different serialization. They are consistent today, but there are now two sources of truth.
- `outcomeMoney` rounds P95 to 8 decimal places and can round down, so cost exactly at the P95 point counts as overrun. The effect is at most 5e-9 chaos.
- The GET endpoints write signal state and history, and do up to 50 recipes × (an analysis read, up to 20 risk-run reads, and up to 9 liquidity reads). That is bounded but heavy for a read.
- `history()` uses `storedStateSchema.parse` per row, so one bad row fails the whole response.

## Verified correct

- **Cohorts and listings:** exact target + league cohorts. Listing counts are taken before seller aggregation (`matchingRecipeListings`), and `totalListings === matched unique listings` is required for "complete". Stale, future-dated, incomplete and foreign-currency evidence all fail closed.
- **Own sales:** keyed by the item's actual output signature (`factoryLedger.ts:529-546,604`). Time listed (listed→sold) and holding time (produced→sold) are kept separate. Disappeared listings are counted as `missing` only and never treated as sales.
- **Confirmations:** require a distinct observation ID plus the minimum time gap; repeated reads of the same snapshot add nothing. Confirmations reset on a risk-run or settings change; a changed model or prices changes the risk ID.
- **Allocation scope:** only whole saved objectives; no P95 scaling; at most one option per recipe. Spend respects reserve, per-target exposure and shared cohort sales capacity. Target-success objectives with saleable failed outputs are rejected; unvalued retained assets block attempts objectives. Greedy selection is disclosed as not globally optimal.
- **Uncertainty bound:** ε = √(ln(4m/α)/(2n)) is correct two-sided DKW + Bonferroni over 2m CDFs. P(cost > empirical P95) ≤ 0.05+ε holds with the ceil-index quantile. The analytical geometric P95 is exact (ε=0). Loss and overrun are combined by a union bound, with no independence assumed.
- **Money:** Decimal arithmetic throughout, schema-bounded.
- **Quotes:** manual or assumed sale prices are rejected for saleable outputs; cost assumptions are allowed and labelled.
- **Endpoint access:** every `/api/admin/` route requires the local-owner admin check and is served `no-store`. Saved-plan idempotency is a lock plus hash check, with a conflict on a different request.

## Limitations

- I did not execute any tests, typecheck, lint or browser runs; all of the above comes from reading the code.
- I did not check the 0027 snapshot JSON or the data-preservation claims.
- I did not verify that `createRecipeMarketDependencies` never calls the trade provider. It appears to build queries only, but I'm not 99% sure.
- No live market data was checked. Whether `hashMarketQuery` matches the stored `canonical_hash` on production data is unverified beyond the implementer's integration test.
