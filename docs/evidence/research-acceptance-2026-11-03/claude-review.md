# Acceptance review: MAX-1288 research run 2026-10-30-manual

## Verdict

- **The P0–P5 declared scope is complete, but only for content and mechanics.** `checkpoint.json:10` says `COMPLETE_FOR_DECLARED_RESEARCH_SCOPE`, `closure-recovery/final-gate-qa.json` says `PASS` with no blocking findings, and `coverage.json:40` says `required_scope_gaps_open: 0`.
- **None of it supports a commercial claim.** Every profile has `profit: null`, `financial_acceptance: false` and `import_ready: false`.
- **All 16 original candidates are kept**, in `final-decisions.json`: 6 accepted, 1 merged as an alias (`srs-nonpoison-helmet` → `spectre-minion-helmet`) and 9 excluded with reasons. Six more profiles bring the total to 22. Excluded profiles are also listed in `rejected.csv:12-25`.
- **Before the schema-v3 import:** three high-severity issues need handling in the import adapter (H1–H3 below). No new research is needed for them.
- **Not checked:** I could not recompute the SHA-256 hashes in `final-gate-qa.json:67-83` because I had no shell. I also did not re-run any crafts or PoB.

## Which source wins when they disagree

1. `final-recipes.json` and `final-decisions.json`. The gate pinned their hashes.
2. Raw receipts, for numbers the final files leave out: `closure-bases/results.json` and `closure-recovery/*` (bow cost model, `bow-cost-reconciliation.json`).
3. Top-level `final_*` fields in `catalog.reviewed.json`. The catalog itself says `historical_details_superseded_by: final-decisions.json`.
4. `coverage.json` and `checkpoint.json`.
5. The latest section of `audit.md`.
6. Everything else is history only: `followup-*`, `agent-*`, `resume.md`, and the nested `research_review` and `patch_followup` blocks in the catalog.

One example: for the TR helmet, `closure-bases/results.json:248` accepts 8–10 AoE, but the final recipe requires exactly 10 (GATE02). The final recipe wins.

## Findings

| # | Sev | Finding | Pointers | Interpretation / action |
|---|---|---|---|---|
| H1 | High | **The RF observation does not show demand for the accepted Fire Trap recipe.** 11 of 20 helmets had Burning + Concentrated together, but which skill was socketed was never checked. `rejected.csv:2` says the seed source S10 (Pohx) is a *socketed-RF* craft, and the accepted Fire Trap scope rests on one author source (`independent_build_recommendations: 1`). The catalog still lists S10 and links the C01 cohort to this profile. | `bundle_stats.json:4-6`, `catalog.reviewed.json:38-43,108-113`, `closure-bases/results.json:396` | Import the cohort as unlinked or "related bundle". Do not use it as `demand_signal` for `rf-fire-trap-helmet`. The 11/20 may describe the rejected `rf-life-stacking-helmet` scope instead. |
| H2 | High | **Stage counts are not whole-chain expected use.** Usable whole-chain figures exist only for the bow (one run of 100,000 actions), RF (reforge stage plus a fixed 4c bench step) and the Spectre helmet and shield (Greed stage plus a fixed bench step). Lacerate, the TR helmet and the Fear gloves have no valid expectation. | `closure-bases/results.json:116,165,215,270,324-328` | For Lacerate, the TR helmet and the Fear gloves, `expected_use` must be null. Old numbers must not be imported: 1.44%/70, 12.3%/9, Fear 35 (core only), 833/41650 at ilvl82, Warlock 178/10000, quiver 275/816530, belt 154/10000. |
| H3 | High | **Starting-base conditions differ from finished-item filters.** `base_conditions` holds starting inputs: ilvl83/70/75/60/85/85/78, influence, fracture. The finished-item fields in `market_fetch_backlog.json` are different (for example "Rare helmet; exact base optional", "Bone/Fossilised Spirit Shield", "base pending"). | `final-decisions.json` `base_conditions`; `market_fetch_backlog.json:12-14,81-84,117-119,153-155` | This is correct under protocol P2. The risk is a schema-v3 mapper copying `base_conditions` into the finished-item filter. Keep two separate fields. |
| M1 | Med | **The RF market data is stale and shows no margin.** The Elder Archdemon base asks were all 1 div. The 20/20 finished asks start at 1 div. Most listings were displayed as 2–3 months old. It is one Instant-Buyout snapshot from 2026-10-30, now 4 days old. | `followup-market-rf/preferred-base-and-support20.md:9-61` | This is a dated ask floor, not a price and not evidence of margin. Re-snapshot before use. |
| M2 | Med | **The Spectre helmet's "low-budget" label conflicts with its expected cost.** The calculator expects about 1,465 Deafening Greed per success (0.0683%). In the cohort, 18 of 20 helmets were unique and the bundle matched 1/20 (helmet) and 1/17 (shield). | `closure-bases/results.json:164-167`, `bundle_stats.json:49-92` | These are equipment observations, not demand. Do not carry the "low-budget" stage label as a cost class. |
| M3 | Med | **`resume.md` is stale, and `checkpoint.json:9` points to it as `next`.** It cites 17 routes, five trade captures, 189 theoretical unexecuted Scours, Fear 178/10000 as current, and `acceptance-gaps.json`. It has no pointer to the final files. | `resume.md:3-8`; compare `audit.md:44`, `final-gate-qa.json:31` | The final files and the latest closure section of `audit.md` win. Do not use `resume.md` as handbook input. |
| M4 | Med | **The bow's whole-chain figures come from one stochastic run.** 31 finished bows, 162 actual failure Scours, 32 base instances. Per finished bow that is about 3,188 Alterations, 10.8 Divine, 9.8 Exalted and 6.3 Annul/Regal/Transmute. Base preparation was done in the beta UI and the main run in stable. The socket/link bench (350 Jeweller + 1500 Fusing per base) was not executed. | `closure-recovery/bow-complete-cost-model.json:3-45`, `bow-cost-reconciliation.json:28-38` | With 31 successes the sampling uncertainty is roughly ±35%. The partial cost of 3,911c per bow covers only Divine, Exalted and Chaos, so it is not a full cost. The author's 5–8 Div estimate is not reproduced. |
| M5 | Med | **The SRS merge narrows the target.** The SRS source accepts +1 or +2 minion levels. The canonical recipe targets +2 only, life-based, on a Bone base. | `final-decisions.json:193-208` | Keep the alias row with its own scope. Do not let it inherit Spectre cohort stats or the Spectre budget stage. |
| L1 | Low | **Stale fields nested in the catalog:** `research_review.verification_status: normalized_research_lead`; the RF entry still lists "Elder pure armour helmet budget"; the Lacerate note still says "single 3–5% tier at ilvl68"; `economic_status: not_evaluated` is not in the plan's vocabulary (`approximate`/`verified`/`unavailable`). | `catalog.reviewed.json:18-19,101,232,52` | Import only the top-level final fields. |
| L2 | Low | **The corrected RF 83 expectation is missing from `final-recipes.json`.** 910 reforges / 45,500 Wild (20/20) and 94 / 4,700 (any tier) appear only in `closure-bases/results.json:51-64` and `audit.md:44`. The file `elder-archdemon-base82.*` is named for 82, but its query is ilvl ≥82 and every result is 83. | `final-recipes.json:61`, `followup-helm/rf-chain/results.json:6,24` | The receipt wins. The ilvl82 chain is historical. |
| L3 | Low | **Gaps in executed failure recovery.** Paid failure recovery was executed for all 7 recipes, with two exceptions: the TR helmet's exact-10 AoE retry (bench removal) was executed on the bow, not the helmet, and the bow's socket/link steps were not executed. The Spectre helmet's finished example (18% implicit) and its failure/Scour receipts (16%) come from different item instances. | `final-recipes.json:236,476`, `closure-bases/results.json:141` | Disclosed in the files. Mark as "data-backed, not executed". |
| L4 | Low | **Count drift between files:** trade captures 5 (`audit.md`, `resume.md`) vs 7 (`coverage.json:28`); the P5 entry in `audit.md` still says "задача не завершена" ("task not complete"). | `audit.md:8,39` | `coverage.json` and `checkpoint.json` win. `audit.md:33` itself says later entries replace earlier ones. |

## How old the sources are (as of 2026-11-03)

- **Trade asks:** captured 2026-10-30 between 08:29 and 10:00 UTC, so 4 days old. One snapshot each, Instant Buyout only, listings often displayed as months old.
- **Price aggregates:** 2026-10-30, with Divine at 359c.
- **Week 1 cohorts:** the calendar timestamp is unknown. They are not time-aligned with current asks, and protocol §P5 forbids combining them.
- **Affinities:** crawled 2024-08-20, Settlers league. Not usable for 3.29.
- **PoB exports:** the Spectre and Lacerate headers say 3.28 while the guides say 3.29.
- **Game data:** pinned to RePoE 3.29.3.3, with patch notes read through 3.29.3b. `final-decisions.json:172` notes later changes to Fractured Fossils and bench rerolls, so the data may have drifted since the pin.

## What is still unknown for release and economics

These are outside the research scope and should not be filled in as zero:

1. **Input prices:**
   - Shaper Pinnacle ilvl70, Bone ilvl75, Fossilised ilvl60 and Grizzly ilvl85 bases have no price.
   - No qualified Hunter Thicket bow listing was observed.
   - The Fear gloves base is a single 13 Divine ask.
2. **Unpriced currency:** Alteration, Scouring, Transmutation, Regal, Annulment, essences, Wild lifeforce, bench unlocks and gold fees.
3. **Whole-chain expected use** for Lacerate, the TR helmet and the Fear gloves (including the implicit stage).
4. **Finished-item comparables** for the Spectre helmet and shield, the TR helmet and the bow.
5. **Market behaviour:** repeated time-aligned snapshots, sales, liquidity.
6. **Validation:** whole-build checks in the live game or PoB.
7. **Demand:** there is no measured buyer demand at all. Equipment observations exist only as exploratory cohorts of 20 characters.
