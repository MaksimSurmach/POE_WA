# MAX-1287: belt research and evidence

## Two real research profiles

- **Flicker Strike Slayer, Stygian Vise, Allflame 3.29**: [guide](https://odealo.com/articles/trinity-flicker-strike-slayer-build-1) specifies at least 100 life, 80 total elemental resistance and 30% elemental damage with attacks. Item level, influence and corruption requirements are not stated. On 2026-10-29 at 20:34:59 UTC, an Instant Buyout search showed five selected listings at 1 divine each. Two cheaper matches in chaos were not mixed with these. [Manual observation](evidence/max-1287-flicker-trade-2026-10-29.json) records the exact selected rows, search, seller, visible stats, gold fee and relative listing age. Prices are asks, not sales.
- **Winter Orb Elementalist, Stygian Vise, Allflame 3.29**: [PoB](https://pobb.in/W4yCI3RRdniV) describes 110+ life, 26–30% chaos resistance from Essence of Envy and additional resistances without a numeric threshold. Five selected Instant Buyout listings with life >=110, chaos resistance >=26 and at least one other resistance were visible at 60–120 chaos on 2026-10-29 at 20:33:56 UTC. [Manual observation](evidence/max-1287-winter-orb-trade-2026-10-29.json) contains the selected raw transcriptions and scope.

These are manually selected snapshots, not market-wide representative samples. Trade listing age is not sale velocity, and Instant Buyout may charge a gold fee. The records deliberately do not infer influence, corruption or missing resistances. They are not proof of full comparability: executable target rules and the remaining build requirements have not been verified. The application reports `PARTIAL` and `INSUFFICIENT_DATA` rather than ranking these offers.

The Winter Orb method uses the Allflame mechanic and instructs replacement of a base after excess Intangibility. Success probability and replacement cost are unknown; the current economics engine assumes repeated attempts on a reusable base, so it must not calculate this method. The Flicker guide describes desired gear but does not establish a complete reproducible crafting method or probability. No real expected craft cost or potential spread is asserted for either profile.

To load these dated observations into the configured PostgreSQL database without modifying existing records:

```sh
pnpm market:seed-library
pnpm market:import-belt-evidence
```

The second command is idempotent for the same target and observation. These observations are historical after their capture time and the freshness gate will eventually prevent valuation. They are never merged with demo data.

## Product workflow

The target form accepts explicit modifier thresholds, optional total elemental resistance, method steps, a probability or expected attempts, and dated manual base/material prices without JSON. The matching v2 sums three explicit per-element values and treats missing values as unknown. Version 1 retains its original behavior. The form supports methods only when the operator confirms that all attempts use the same base with no replacement, recovery or finishing costs. Other methods remain uncalculated.

The snapshot form accepts individual user-entered listings and optional original text without JSON. Raw saved item payloads remain unchanged. Each snapshot uses one currency; there is no invented exchange rate. The analysis records per-row reasons, excludes nonmatches and deduplicates sellers. A fresh sample requires at least five confirmed independent sellers; the conservative asking estimate uses the cheapest confirmed offer. User confirmations and manual prices are assertions, not automatic source verification.

New price observations are stored separately from immutable target profiles, with source, time, league, patch, currency and data kind. Their history is visible in the price dialog. The latest matching-kind update is used, with no fallback for missing material prices; stale or incompatible prices block calculation. A valid calculation is `CALCULATED` with `POSITIVE` or `NON_POSITIVE` as a separate economic conclusion. No calculation is a guarantee of a sale.

## Reproducible checks

The separate `pnpm market:seed-belt-demo` remains a synthetic test, explicitly marked DEMO. Its inputs are 10 chaos base, 2 chaos per attempt and a synthetic 25% chance, giving 10 + 4 × 2 = 18 chaos expected cost; the selected cheapest asking price is 40 chaos, yielding an illustrative 22 chaos difference. Updating the synthetic base to 40 gives 40 + 4 × 2 = 48 chaos and a negative 8 chaos difference. These are regression checks only, not real market or probability evidence.

Local checks on Node 24: workspace unit suite, typecheck, lint and build; isolated PostgreSQL 17 integration and migration checks; UI forms, manual demo import and price history, and API restart. Refer to PR CI for supported Node 22.

## Blockers

- Obtain and independently validate the exact crafting recipe and probability, including base replacement, recovery and finishing operations, for each profile. The present calculator cannot model the Winter Orb Allflame replacement process.
- Obtain a dated, genuinely comparable craftable base quote and same-currency material observations. BaseType aggregates do not establish the required item level/influence. No FX rate is assumed.
- Verify complete requirements and listing properties before confirming comparable matches. The observed Trade records are available but currently partial. Independently recalculate a **real** complete example once those missing inputs exist.
- OAuth or a password does not supply a documented Trade-search API. The user signed in normally and the observations were read from the official UI; no cookies, credentials, undocumented API or trade action were used. New OAuth application registrations were previously reported paused; verify directly with GGG before planning a Public Stash integration.

Do not close MAX-1287 until two real end-to-end outcomes are supported by evidence; a negative outcome is a valid outcome.

## Additional real input observations

At 2026-10-29 20:36:51 UTC, the documented poe.ninja Allflame Essence overview returned **3.33 chaos** for `Shrieking Essence of Envy`. [PoE Wiki](https://www.poewiki.net/wiki/Shrieking_Essence_of_Envy) identifies its belt modifier as 26–30% chaos resistance. This is a public economy estimate, not a captured individual offer; the full raw economy response was not saved. [Source](https://poe.ninja/poe1/api/economy/exchange/current/overview?league=Allflame&type=Essence).

At 2026-10-29 20:37:32 UTC, a [Trade Instant Buyout search](https://www.pathofexile.com/trade/search/Allflame/H4sIAAAAAAAAE1VOSwqDMBC9SnnrbAsl1yh0U6RMNZaBmEhmLIjM3SWWQlzNPN53gyjpIvAb8qycEzwk9EuhdwwwB13nAI-7rh-mdHmwBLjDJfDP7c9TGuAwctRQKtFZ18Cf7NXg5i1UWNfTgpTLRBFm5jCx9K1zYKnbBviRooRTC8dvrHfiBH-7mkOfS1lmrfIm_3DWeLMdbyrkhQIBAAA) for normal, uncorrupted Stygian Vise, item level 85+, showed a verified ilvl 85 base for **3 chaos**, seller Гуган#4837, listed 20 hours earlier, and another for **5 chaos**, seller Horatio_Kain#2571, listed 4 hours earlier; each displayed a 1,358 gold fee. The search does not establish whether those bases satisfy every method-specific condition, including initial Intangibility or influence. These individual observations do not establish expected crafting cost, and item level 85 is an explicit research filter rather than a claimed guide requirement.

## Probability and base-replacement investigation

On 2026-10-29 at approximately 21:50 UTC, the [Craft of Exile calculator](https://www.craftofexile.com/?game=poe1&b=3&bi=7805&m=essence&e=1231&ob=both&v=d&a=x&l=a&lg=23&bp=y&as=1&hb=0&req=%7B%221775%22:%7B%22l%22:44,%22g%22:1%7D%7D) showed **10.505%** for a Stygian Vise with an Envy essence and a life tier of 100–114 or better. Its exchange link identified the essence as _Deafening_. This is an investigative control, not either profile's probability: it admits 100–109 life, does not impose Winter Orb's other resistances or Flicker's attack damage and total resistance, and does not model the guide's Allflame replacement sequence. The level field displayed 85, but the generated link did not preserve that field; the result is not established as reproducible for the observed ilvl 85 base. The calculator describes its newer beta as supporting Allflame and multi-step simulation; a validated complete simulation and independent probability check are still needed.

For Winter Orb, **3 or 5 chaos plus 1,358 gold is the asking price of one candidate base**, not the expected replacement cost per successful craft. The source guide says to replace the base after exceeding 25% Intangibility; the initial Intangibility, number of attempts per base, per-attempt probability, sulphur usage and remaining resistance threshold have not been verified. Until then neither expected replacements nor a real total cost can be calculated. For Flicker, the guide does not specify a recipe; the same candidate base asks cannot establish replacement costs or success probability for an undefined method. A reproducible recipe with verified mod probabilities and fresh prices is required for each profile.
