# Full real-data audit — 18 November 2026

**128/128 current search configurations collected; 72/72 recipes audited**, with one acquisition and one output search linked to each recipe. Snapshot: **2026-11-18 10:38:40.492 UTC**. This is a current database copy plus real authenticated Trade collection, served by the normal shipped API and collector; no fixture or archive responses serve acceptance.

The original full request remains **failed**: 130 successful jobs (127 Trade + three maintenance), one Slink timeout, none pending. Its correlated normal-worker recovery succeeded with 100 matched listings and 99 sellers. The subsequent 62-profile output freshness sweep retained its own **58 successful unchanged profiles** plus an immutable provider429 failure (recovered by a separate correlated retry). Three old-query requests were superseded by the final class corrections; three separate normal tests collected those corrected queries. All 62 current profiles were refreshed; original request statuses remain recorded separately. These original failed requests were not rewritten to successful states. Normal dispatch was restored with fresh next-due advances retained; superseded and diagnostic searches stay disabled. See [original batch](original-batch.json), [output refresh](output-refresh-62.json), [scoped429 recovery](output-refresh-rate-limit-retry.json) and [dispatch restoration](dispatch-restored.json).

## Price coverage

- Current comparable asking estimates at this snapshot: **41/72**.
- Recipes with prices independently reconciled to actual raw captures during the audit: **55**. These checks use their real recorded check times; an earlier validated quote is not presented as current after expiry.
- Every remaining row has an explicit unavailable-price reason. Zero unexplained price gaps. All 128 generated Trade links match normal worker wire requests.
- [All72 CSV](recipes-72.csv) · [all72 JSON and freshness deadlines](recipes-72.json) · [all128 searches and matching diagnostics](searches-128.json) · [independent current price reconciliation](independent-price-check.json) · [dated check ledger](price-check-ledger.json) · [raw storage/price quality](data-quality.json) · [query/link identity](trade-links.json).

| Current result               | Recipes |
| ---------------------------- | ------: |
| Capture expired              |      20 |
| Comparable asking estimate   |      41 |
| Complete search: no listings |       3 |
| Incomplete market coverage   |       8 |

The table separates the current asking quote from a dated independently checked quote on the same capture. All amounts are chaos; published JSON/CSV includes source IDs, capture timestamps, validity deadlines, seller/match counts and failure reasons. Blank values stay unknown. Provider rate limits and the 120-minute freshness policy can make early captures expire during a long collection pass; the policy and clock were not changed to keep those prices visible.

| Recipe                                                                                                | Current ask | Independently checked ask | Checked at (UTC)            | Current result               |
| ----------------------------------------------------------------------------------------------------- | ----------: | ------------------------: | --------------------------- | ---------------------------- |
| Ring · Hunter · Elemental Weakness                                                                    |        75 c |                      75 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Bow Damage Large Cluster · Arcing Shot / Martial Prowess / Tempered Arrowheads                        |           — |                   385.4 c | 2026-11-18 10:19:57.935 UTC | Capture expired              |
| Bow Damage Large Cluster · Arcing Shot / Martial Prowess / Tempered Arrowheads                        |           — |                   385.4 c | 2026-11-18 10:19:57.935 UTC | Capture expired              |
| Bow Damage Large Cluster · Arcing Shot / Martial Prowess / Vicious Skewering                          |     193.7 c |                   193.7 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Bow Damage Large Cluster · Arcing Shot / Martial Prowess / Vicious Skewering                          |     193.7 c |                   193.7 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Chaos Damage Large Cluster · Grim Oath / Touch of Cruelty / Wicked Pall                               |           — |                      72 c | 2026-11-18 10:25:27.397 UTC | Capture expired              |
| Chaos Damage Large Cluster · Touch of Cruelty / Unholy Grace / Wicked Pall                            |           — |                      60 c | 2026-11-18 10:19:57.935 UTC | Capture expired              |
| Перчатки · life 100+ / suppression 11+ / attack speed 14+                                             |           — |                         — | —                           | Incomplete market coverage   |
| Cold Damage Large Cluster · Sadist / Snowstorm / Widespread Destruction                               |    1549.6 c |                  1549.6 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Fire Damage Large Cluster · Prismatic Heart / Smoking Remains / Widespread Destruction                |       120 c |                     120 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| T2 · Harpyskin Gloves · фрактура / attack speed                                                       |    1355.9 c |                  1355.9 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| T1 · Lich's Circlet · резерв / мана                                                                   |           — |                   770.8 c | 2026-11-18 09:54:50.421 UTC | Capture expired              |
| Remarkable + Grand Design · 4 passives                                                                |     387.4 c |                   387.4 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Remarkable + Grand Design · 5 passives                                                                |       300 c |                     300 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Pressure Points + Basics of Pain · 4 passives                                                         |     193.7 c |                   193.7 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Pressure Points + Basics of Pain · 5 passives                                                         |        70 c |                      70 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Blessed Rebirth + Life from Death · 4 passives                                                        |           — |                     220 c | 2026-11-18 10:19:57.935 UTC | Capture expired              |
| Blessed Rebirth + Life from Death · 5 passives                                                        |       229 c |                     229 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Mob Mentality + Lead By Example · 4 passives                                                          |       120 c |                     120 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Mob Mentality + Lead By Example · 5 passives                                                          |       135 c |                     135 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Bone Helmet · +2 Minion Gems                                                                          |           — |                         — | —                           | Capture expired              |
| Convoking Wand · Fear +1 / Speed / Trigger                                                            |    2711.8 c |                  2711.8 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Convoking Wand · +2 · 3 fossils · ilvl 82                                                             |           — |                         — | —                           | Incomplete market coverage   |
| Fossilised Shield · +1 Minion Gems                                                                    |    2324.4 c |                  2324.4 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Physical Cluster Jewel · 2 Notables                                                                   |        33 c |                      33 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Physical Cluster Jewel · 3 Notables                                                                   |           — |                     300 c | 2026-11-18 10:14:56.350 UTC | Capture expired              |
| Physical Cluster Jewel · 3 Notables                                                                   |           — |                     300 c | 2026-11-18 10:14:56.350 UTC | Capture expired              |
| Quicksilver · Alchemist T1 · 14% speed / 70% effect                                                   |           — |                         — | —                           | Complete search: no listings |
| Quicksilver · Mageblood · 14% speed / 70% effect                                                      |     387.4 c |                   387.4 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Elder Fire Trap Helmet · Any Support Tier                                                             |           — |                         — | —                           | Capture expired              |
| Elder Fire Trap Helmet · Level 20 Supports                                                            |           — |                   770.8 c | 2026-11-18 09:54:50.421 UTC | Capture expired              |
| Ring · Warlord · Vulnerability                                                                        |           — |                         — | —                           | Capture expired              |
| Attack Damage while holding a Shield Large Cluster · Fuel the Fight / Heavy Hitter / Veteran Defender |        89 c |                      89 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Attack Damage while holding a Shield Large Cluster · Fuel the Fight / Heavy Hitter / Veteran Defender |        89 c |                      89 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Enduring Composure · 2 passives                                                                       |           — |                         — | —                           | Incomplete market coverage   |
| Fettle · 2 passives                                                                                   |           — |                     120 c | 2026-11-18 10:19:57.935 UTC | Capture expired              |
| Stygian Vise · Life, Fire and Chaos · Envy                                                            |     968.5 c |                   968.5 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Stygian Vise · Life, Fire and Cold · Fossils                                                          |    1355.9 c |                  1355.9 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| T2 · Sunfire Circlet · резерв / мана                                                                  |           — |                   770.8 c | 2026-11-18 09:59:51.911 UTC | Capture expired              |
| Suppression Boots · Ailment Avoidance and Movement                                                    |    1355.9 c |                  1355.9 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Suppression Gloves · Minion Damage                                                                    |      1937 c |                    1937 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Suppression Gloves · Attack Speed                                                                     |    3486.6 c |                  3486.6 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Twilight Regalia · 6L 940+ ES · Woe T1 plan                                                           |     387.4 c |                   387.4 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Damage with Two Handed Weapons Large Cluster · Brutal Infamy / Feed the Fury / Smite the Weak         |       150 c |                     150 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Damage with Two Handed Weapons Large Cluster · Brutal Infamy / Feed the Fury / Smite the Weak         |       150 c |                     150 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Damage with Two Handed Weapons Large Cluster · Brutal Infamy / Fuel the Fight / Smite the Weak        |        80 c |                      80 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Damage with Two Handed Weapons Large Cluster · Brutal Infamy / Fuel the Fight / Smite the Weak        |        80 c |                      80 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| T1 · Velour Gloves · фрактура / attack speed                                                          |           — |                   963.5 c | 2026-11-18 10:14:56.350 UTC | Capture expired              |
| Week 1 · Apothecary's Gloves · DoT / life / resists                                                   |        25 c |                      25 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Week 1 · Bone Helmet · +1 minions / life / fire                                                       |     387.4 c |                   387.4 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Week 1 · Broadhead Arrow Quiver · life / speed / fire                                                 |         4 c |                       4 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Week 1 · Crystal Belt · ES / fire / cold                                                              |       150 c |                     150 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Week 1 · Fingerless Silk Gloves · ES / fire                                                           |        30 c |                      30 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Week 1 · Gripped Gloves · speed / life / fire                                                         |           — |                         — | —                           | Complete search: no listings |
| Week 1 · Heavy Belt · life / fire / chaos                                                             |           — |                     110 c | 2026-11-18 10:14:56.350 UTC | Capture expired              |
| Week 1 · Hubris Circlet · ES / fire                                                                   |           — |                         — | —                           | Capture expired              |
| Week 1 · Leather Belt · life / fire / chaos                                                           |       120 c |                     120 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Week 1 · Lich's Circlet · ES / fire                                                                   |           — |                         — | —                           | Incomplete market coverage   |
| Week 1 · Royal Burgonet · life / fire / cold                                                          |           — |                         — | —                           | Incomplete market coverage   |
| Boots · Zeal · movement / life / suppression                                                          |           — |                         — | —                           | Incomplete market coverage   |
| Gloves · Zeal · attack speed / life / suppression                                                     |       129 c |                     129 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Week 1 · Spiked Gloves · speed / life / fire                                                          |           — |                         — | —                           | Complete search: no listings |
| Week 1 · Spine Bow · physical / local attack speed                                                    |         8 c |                       8 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Week 1 · Stygian Vise · life / fire / chaos                                                           |     968.5 c |                   968.5 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Week 1 · Thicket Bow · 6L / +2 bow gems / speed                                                       |       190 c |                     190 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Week 1 · Titanium Spirit Shield · ES / fire                                                           |           — |                         — | —                           | Incomplete market coverage   |
| Week 1 · Twilight Regalia · 6L / ES / fire                                                            |           — |                         — | —                           | Incomplete market coverage   |
| Week 1 · Two-Toned Boots · movement / life / defence                                                  |     774.8 c |                   774.8 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Week 1 · Vaal Regalia · 6L / ES / fire                                                                |        90 c |                      90 c | 2026-11-18 10:38:40.060 UTC | Comparable asking estimate   |
| Week 1 · Warlock Boots · ES / movement / fire                                                         |           — |                         — | —                           | Capture expired              |
| Week 1 · Warlock Gloves · ES / fire                                                                   |           — |                         — | —                           | Capture expired              |
| T1 · Wyvernscale Gauntlets · фрактура / attack speed                                                  |           — |                   770.8 c | 2026-11-18 10:14:56.350 UTC | Capture expired              |

## Reproduced defects and fixes

- [Same immutable captures](same-capture-parser-proof.json): Spine Bow matching **23 → 49**, modeled asking estimate **25 → 8 chaos**. This is parser comparison on one actual capture, not an invented quote or a changed market. The raw matching minimum stayed 8; newly recognized matches changed outlier selection. Thicket matching improved 8 → 9. A matching mirror-priced item remains blocked; an irrelevant fusing-priced item clears the currency block only after definite rejection.
- [Native acquisition replay](native-acquisition-replay.json): six unsuitable bases among 106 observations across the three affected captures; all five configured native-implicit acquisition guards verified. New acquisitions use the required modifier floors.
- [RF full-goal A/B/A](rf-support-aba.json): legacy support IDs returned zero, current effect IDs returned 118 full-goal matches, legacy IDs again returned zero. Only the two IDs changed. This temporary allow-list worker was diagnostic only and its schedules were disabled afterward.
- [Final normal-entrypoint tests](normal-final-wire-tests.json): RF Any fetched/matched 100/100 with honest partial coverage; RF level 20 fetched/matched 13/13, complete; ordinary helmet returned one actual Prophet Crown and matched it. The normal compiler/worker now send current wire IDs while preserving canonical identities and all other requirements. [Titanium native-filter proof](titanium-native-filter-proof.json) records a later 480,014ms partial capture retaining 114 actual rows: 70 matched and 44 below the actual ES floor were rejected; its recorded reason remains PRICE_SLICE_LIMIT, not a claimed CAPTURE_TIME_BUDGET outcome.
- [Eleven correlated correction tests](corrected-search-tests.json) preserve their original state/diagnostics. The two early helmet results were unknown under the then-current class map; exact official helmet metadata and the subsequent normal test above close that defect. Historical receipts are not rewritten to pretend the matcher was already fixed.
- Fresh asking evidence has an independent capture/FX deadline. Expired crafting inputs do not hide an otherwise current output quote. Author-defined profit blocks no longer hide matching asking quotes, but still block catalog ROI, grades, success and downstream outcome valuations.

- Three remaining ordinary suppression outputs now use their supported glove/boot category while preserving every output floor and exact acquisition constraint. All 72 canonical signatures are unchanged. Initial corrected normal-worker results before the final parser correction below: **suppression-gloves-zeal: 8 fetched, 8 matched, complete; suppression-gloves-fear: 3 fetched, 3 matched, complete; suppression-boots-loathing: 8 fetched, 2 matched, complete**. A complete empty result remains empty; a partial sample is not a market floor. [Before/after migration](ordinary-class-migration.json) · [correlated normal tests](ordinary-class-tests.json).
- [Actual fractured-mod evidence](fractured-explicit-live-proof.json): explicit suppression filters with the recorded min8/min11 bounds returned modern raw fractured +14% suppression. This proof does not pretend those older queries used min14. The separate [min14 proof](fractured-explicit-min14-live-proof.json) verifies all three latest corrected searches against actual fractured +14% modifiers.
- A narrowed owner cohort cannot supply ROI for the broader authored craft. Any configured/authored output digest difference conservatively blocks profit and downstream valuations while keeping the asking quote and independent cost. [Actual current72 cohort identities](output-cohort-identities.json) all align. Twelve intentional query corrections and ten authored recipe content-hash changes leave canonical identities intact.

- Final fractured-origin repair: all128 current captures / 2,678 actual output rows exposed seven false rejections. Two exact mappings recover fractured movement speed and socketed bow-gem levels. On unchanged real captures, Boots matching **2→8 of8**, Thicket **8→9 of9** through the normal API; starting-base provenance is preserved and conditional +11% speed stays excluded. [Audit](missing-origin-full-audit.json) · [same-capture proof](final-origins-same-capture.json) · [normal collector follow-up](final-origins-tests.json).

## Review and browser acceptance

[Checks, actual Claude review and peer finding closure](review-and-checks.md). At source `9316d05`, **1,039 automatic tests + 208 isolated PostgreSQL integration tests** pass. [Source CI](https://github.com/MaksimSurmach/POE_WA/actions/runs/44287022525). The final evidence commit has its own exact-head GitHub checks.

[Browser receipt](browser-check.json): actual Lich asking estimate **757.6 chaos**, one matched item/seller, complete capture, with cost and margin left unknown. Recipe and Market agree. Settings show All helmets and the original four modifier floors; current diagnostics show 1 matched, 0 unknown. Desktop 1280px and mobile 390px have no horizontal overflow. The historical recipe-update notice remains historical in both places.

![Actual quote with profit withheld](recipe-price-real.jpg)

[Market view](market-price-real.jpg) · [Saved search and actual matching](settings-match-real.jpg) · [Mobile requirements](recipe-mobile-real.jpg) · [Mobile price](recipe-mobile-price-real.jpg) · [Category Library](recipes-real.jpg)

Actual crafting, completed sales and realized ROI were not tested. Partial search coverage, unavailable conversion and expired evidence remain explicit limitations, never fabricated prices.
