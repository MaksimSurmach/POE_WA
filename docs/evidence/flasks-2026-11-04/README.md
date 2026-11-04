# Quicksilver flask recipes — 2026-11-04

Two craftable magic Quicksilver variants join the existing recipe catalog. Both buy an uncorrupted magic base of exactly item level 85 and 20% quality, roll 25% explicit effect plus exactly 14% movement speed, then finish with exactly 70% Enkindling effect.

- Mageblood: accepts all three 25% effect prefix tiers. Reduced duration does not affect Mageblood's always-applied flask effect. Rounded CoE mean 1,005 Alterations for the tier pair × three possible speed values = 3,015 Alterations.
- Alchemist T1: additionally requires reduced duration 23–27%. Rounded CoE mean 3,035 × three speed values = 9,105 Alterations.
- Both pay an expected 28.6 Enkindling Orbs: effect-family weight 250 / total weight 650 / eleven integer rolls. This finish is separate from the explicit effect modifier.

These are conservative Alteration-only models, not optimal Alt+Aug routes or guaranteed budgets. Rejected rolls, time, gold and resale by-products receive no revenue credit. The exact-roll multiplier derives from CoE's inspected uniform integer implementation; it is not an empirical measurement of game frequencies. The cheaper 12–13% movement and 60–69% enchant cohorts cannot value these targets.

## Evidence

- `calculator.json`: both exact calculator URLs, rounded tier means and derivation.
- `integer-roll-implementation.json`: independent reviewer’s package/data hashes, symbol offsets and short excerpts from already-retrieved public CoE files.
- `trade-identities.json`: dated supplement to the November 3 mapping receipt. New stat identities match successful current Trade listing hashes and the pinned Awakened PoE Trade map. The Enkindling slug and image are present in the current Currency snapshot.
- `market.json`: successful live research queries, fetched counts, independent seller counts, and the cheapest five distinct sellers among exact-quality matches. Seller names are hashed. Original currency is retained: chaos conversions can differ between captures as FX changes.

Research found a normal quality-20 base from only one seller. The recipes therefore acquire the available magic quality-20 base and do not charge a Transmutation. Research base requests allowed quality ≥20; the evidence subset and canonical recipe query require exactly 20. The broad magic-base research collection was stopped after enough distinct sellers were observed; it is not a census. Final application valuation uses the normal recipe collection/publication pipeline, not these manually selected evidence rows.

All prices are asks. No completed in-game sales, sell-through rate or in-game crafts were verified. The official metadata endpoint returned 403; validation used recorded prior identities plus the dated current listing evidence, without retrying the blocked endpoint or disabling schema validation.

## Checks and review

- 606 automated tests plus the native runtime control test passed.
- 140 PostgreSQL integration tests passed against the isolated local `poe_worksmith_test` database.
- Build, lint and 28-recipe schema validation passed.
- Independent math review and independent implementation review found no consequential mismatch. The first math review used a normal base plus Transmutation; the final implementation review checked the available magic-base route with no Transmutation.

## Mixed-currency coverage correction

The first canonical Mageblood refresh fetched only the first 20 Trade IDs. Its comparable sample started at 2 divine (810.4c at its captured FX), while full research found an exact target at 650c later in the result list. Trade sorting therefore did not establish a floor under Worksmith’s currency conversion.

Mixed-currency crafted-output queries now fetch up to 100 listings. A capped, inexact or interrupted output cannot certify a sorted floor, reuse a legacy sorted-prefix cache, contribute a price observation, or publish resale/ROI. Read-time checks also remove previously stored unsupported resale/profit while retaining independently supported costs and an explicit reason. Starting-base acquisition keeps the 20-offer sample: an available purchase price is conservative for cost, even if a cheaper base exists later.

Regression checks cover the cheaper chaos offer after twenty divine asks; cap/inexact/interruption; legacy adapter proof flags; refresh-cache invalidation; observation aggregation; publication; and persisted positive evaluations. Raw snapshots remain intact. Queries above the output cap require a narrower target or future deeper collection; they now show incomplete data instead of a green ROI.

## Installed acceptance

Installed release `flasks-20261104`, code `e4b5355439ecff8a6cf8d6922905bb59354ba0c2`. Native startup/readiness passed. Both exact output searches completed:

| Route                            | Fetched offers | Comparable sellers | Expected cost | Lowest comparable ask | Indicative ROI |
| -------------------------------- | -------------: | -----------------: | ------------: | --------------------: | -------------: |
| Mageblood, any 25% effect prefix |          78/78 |                 49 |    311.65714c |                  650c |   +108.562525% |
| Alchemist T1                     |          30/30 |                 24 |    855.98134c |     808.6c (2 divine) |     −5.535324% |

See `installed-valuations.json` for capture/expiry times, cost multiplication and saved publication evidence. Source quality remains low because starting-base acquisition is a bounded sample. These are current Allflame asks, not executed sales or next-league price forecasts.

Browser acceptance: `/recipes` has 55 entries (28 market recipes plus 27 source guides); the flask filter returns two. Both recipe detail routes display their different costs and ROI signs. At desktop 1440px and mobile 390px, Quicksilver, Alteration and Enkindling images loaded and stayed within their frames; no horizontal overflow. The installed app displayed the −5.5% Alchemist result. The old partial Mageblood evaluation was also checked: its cost stayed visible while ask/profit/ROI were withheld with the coverage reason.

Original collection settings were restored exactly at version 20. Native app/web/PostgreSQL and temporary API/preview/test PostgreSQL processes are stopped. The isolated research database was removed after retaining scoped evidence; application data, backups and rollback releases remain. Login autostart and KeepAlive remain disabled. Physical devices, screen-reader speech, logout/reboot, in-game rolls and completed sales were not tested.

CI passed for installed code: https://github.com/MaksimSurmach/POE_WA/actions/runs/41861193391.
