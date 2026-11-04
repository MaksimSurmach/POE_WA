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

- 596 automated tests plus the native runtime control test passed.
- 140 PostgreSQL integration tests passed against the isolated local `poe_worksmith_test` database.
- Build, lint and 28-recipe schema validation passed.
- Independent math review and independent implementation review found no consequential mismatch. The first math review used a normal base plus Transmutation; the final implementation review checked the available magic-base route with no Transmutation.

Installed refresh and browser acceptance are recorded separately after completion.
