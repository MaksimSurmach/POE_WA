# Per-item configuration audit — 18 November 2026

**Checked all 128 persisted profiles and 72 recipes. Fixed the wrong acquisition rarity in six Jagged recipes.** The owner confirmed **Instant Buyout only**. Ordinary online/offline offers are outside this scope.

[Every item](items-128.csv) records its original conditions, wire filters, capture, coverage, retest/control evidence and after-fix state. The initial 11:03 UTC snapshot had nine complete-empty searches and 54 partial captures; all 119 nonempty captures contained actual matching items. Those initial counts are historical, not the final market state.

## Confirmed correction

Six Jagged methods acquired a normal cluster even though their repeated operation is a full rare-item reroll with a Primitive Chaotic Resonator. This excluded suitable rare bases. The [current item description](https://poedb.tw/us/Primitive_Chaotic_Resonator) explicitly identifies a rare-item reforge. Source/spec agreement initially missed the mistake because both contained the same wrong rarity; the subsequent crafting-input review caught it.

Claude authored the bounded correction. Each source JSON changes only acquisition rarity and explanatory notes/action. Exact levels, variants, finished modifiers, materials, attempt counts, canonical targets and historical calculator evidence are preserved: [six-recipe field comparison](source-preservation-6.json). Historical Craft of Exile inputs still say normal; they are not presented as a new simulation. The existing warning that 3.30 probabilities are unverified remains.

Three revision-checked profile saves correct five recipes. Physical Jagged is relinked to its existing rare 83 profile; its shared normal 83 profile remains exclusively for Alteration. [Migration receipt](jagged-rarity-migration.json) verifies all 72 canonical signatures, all 66 output specs/query keys and source/configured requirements. Source content hashes change for exactly six recipes, fencing their previous economics. No API, worker, schema or dependency was added for this correction.

All four resulting acquisition groups were retested through the normal API → PostgreSQL request/NOTIFY → collector path: [requests and persisted results](jagged-rarity-retests-4.json).

| Corrected rare acquisition               |                        Fresh real result | Interpretation                                               |
| ---------------------------------------- | ---------------------------------------: | ------------------------------------------------------------ |
| Shield attack, exact 68                  |                    2/2 matched, complete | Suitable offers now included                                 |
| Bow, exact 68, two Jagged methods        |                  10/10 matched, complete | Suitable offers now included                                 |
| Two-handed, exact 68, two Jagged methods |                              0, complete | No offers for the exact Instant Buyout query at capture time |
| Physical, exact 83                       | 20/20 matched from 545 reported, partial | Matching sample; no complete price-floor claim               |

Captures ran 12:02–12:03 UTC. All four requests succeeded at current revision/query key. The local library retains 128 profile IDs,72 recipes and 66 outputs; duplicate rare searches reconcile to **125 unique Trade schedules plus three maintenance schedules**. [Final runtime](final-runtime.json) checks 128 current-key captures, no pending manual requests, all diagnostic schedules disabled, and preserved Alteration. [All 128 generated Trade links](trade-link-check.json) match worker queries.

At 12:08 UTC, [all 72 recipe evaluations](recipes-72-after-rarity.json) expose 34 current asking quotes; the others retain their missing/stale/partial reasons. Seven empty profile captures represent six unique queries. Existing captures are reused for unchanged keys; this follow-up is not a second full 125-query batch.

## Every initially empty search

[All nine original exact-query retests](exact-empty-retests-9.json) succeeded after the provider 429 cooldown ended 11:23:14 UTC. They returned zero before the rarity correction. [Seven one-filter controls](filter-controls-7.json), [exact control queries](filter-control-queries.json) and local raw-item replay distinguish incorrect inputs from valid missing offers.

| Initially empty search            | Diagnosis and action                                                                                                                                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shield Jagged normal 68           | Rare-only control found 2; acquisition corrected, fresh rare query matched 2                                                                                                                                                                                                              |
| Bow Jagged normal 68              | Rare-only control found 9; acquisition corrected, fresh rare query matched 10                                                                                                                                                                                                             |
| Two-handed Jagged normal 68       | Acquisition corrected for crafting consistency; fresh rare 68 remains empty                                                                                                                                                                                                               |
| Two-handed Chaos rare 68          | Exact 68 remains empty. Removing only max-level reports 2,168; first 20 are 78–83 and all fail max 68. Exact crafting level retained                                                                                                                                                      |
| Dragonscale Gauntlets acquisition | Exact 85 and fractured suppression≥14 retained. Replacing only origin filter with explicit suppression while retaining fractured-item=true also gives 0                                                                                                                                   |
| Gripped Gloves output             | Life 70/attack speed 17/fire 30/native 22 retained. Removing only native implicit still gives 0                                                                                                                                                                                           |
| Spiked Gloves output              | Life 70/attack speed 17/fire 30/native 24 retained. Removing only native implicit still gives 0                                                                                                                                                                                           |
| Bone Helmet minion output         | Life 91/+2minion gems/fire 29/native 15 retained. Removing only gem requirement reports 123; first 20 satisfy the other requirements but none has+2minion gems; all 20 fail the original target                                                                                           |
| Quicksilver Alchemist output      | Effect 25/duration−27..−23/speed 14/enchant 70/quality 20 retained. [Earlier broader capture](quicksilver-existing-broader-capture.json) has two Dabbler P 2 flasks with duration−31, outside the required Alchemist P 1 band. This 09:49 UTC capture is not a fresh original-query price |

Dense control counts mean reported/fetched, not complete coverage. Controls never supply recipe prices. Zero means the exact observed Instant Buyout query, not global market absence. The original profile revisions/query keys remained unchanged **during the control stage**; [dispatch restoration](dispatch-restored.json) records the then 131 schedules before the later rarity migration. [Diagnostic setup history](diagnostic-setup-history.json) retains the corrected one-off missing discovery flag and its rolled-back attempts.

## Modifier identities and review

[Official metadata and scope](metadata-and-scope.json) covers 93 distinct wire stat IDs, bounds, enum values and two explicit RF aliases. No additional incorrect stat ID or numeric bound was confirmed. Native implicit minima are valid against [GGG armour data](https://www.pathofexile.com/item-data/armour): Spiked 24–30, Gripped 22–28, Bone 20–30. The [official 3.30 patch notes](https://www.pathofexile.com/forum/view-thread/4013680) support the changed native ranges/drop-tier gating. No relevant minion-gem removal was identified there.

[Claude review history](claude-review.json) retains its initial fracture challenge, explicit withdrawal on source/raw evidence, later Jagged authorship and final independent PASS. Root resolved the review limits with actual link/revision checks, zero legacy null-identity results for the six recipes, runtime counts and four real retests. Codex peer review additionally caught stale shared-schedule test assumptions: removing Chaos must preserve Jagged's shared rare acquisition.

[Validation receipt](checks-and-review.json):1,045 automatic checks,208 isolated PostgreSQL integration tests, typecheck, lint and 72-recipe validation pass. Tests use the separate test database; acceptance uses the actual database copy and authenticated Trade data. Historical/full UI acceptance remains linked from the parent folder. [Read-only real-data UI inspection](browser-real-rarity-check.json) confirms rare/shared Chaos+Jagged and separate normal Alteration. The targeted legacy browser scenario also passes after updating its source-backed query/profit expectations; its synthetic fixtures stay in the isolated test database. No new UI changed in this correction.

No production deployment or new 3.30 probability simulation was performed. Actual crafting, completed sales and realized profit were not tested. Partial, expired and empty evidence retain their unavailable-price states.
