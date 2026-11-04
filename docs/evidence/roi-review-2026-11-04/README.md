# ROI and recipe-library follow-up — 2026-11-04

The user requested all positive ROI be audited, including attempt counts, costs,
output variants, overflowing item icons, and a separate crafting recipe tab.

## Scope and calculation findings

All three positive results in the last published 11:59Z evaluation were checked:

| Recipe                                          | Cost (chaos) | Lowest ask (chaos) | Previous ROI | Audited result                             |
| ----------------------------------------------- | -----------: | -----------------: | -----------: | ------------------------------------------ |
| Convoking Wand, bare +2                         |      1898.32 |               8252 |  334.700156% | Withheld: output value unverified          |
| Convoking Wand, Fear / speed fracture / Trigger |    1425.6307 |             3273.6 |  129.624685% | Arithmetic and scoped mean cost reproduced |
| Elder Fire Trap helmet, level 20 supports       |      1262.23 |             2888.2 |  128.817252% | Arithmetic and scoped mean cost reproduced |

These numbers are a replay of saved observations at their original evaluation
time, not newly observed prices. The replay runs on a database copy; production
observations are never backdated. `as-of-recalculation.json` records all material
unit prices, quantities, costs and the publication decision.

An independent live Craft of Exile review reproduced 12 four-fossil sets,
194 Fear essences, and 910 Harvest Fire reforges (45,500 Wild lifeforce). The
latter two include the required free affix and a paid bench finish. No arbitrary
coefficient increase or price haircut was applied. Base acquisition, replacement
count, materials, currency conversion and arithmetic remain explicit.

The bare +2 wand is the confirmed defect: its 12-set model stops at two gem
prefixes, whereas the lowest observed 20-divine asks also have minion speed and
Trigger. A control calculation requiring +2 **and at least 20% minion speed**
returns 112 sets, without guaranteeing space for Trigger. Requiring a free
suffix yields a radically different pure-reroll calculation. A conditional
simulation showed six occupied affixes. None of these controls is substituted
into production: a practical finished-item route needs its own recovery model.
See `calculator-review.json` for exact scopes, URLs and limitations, and
`output-comparison.json` for the observed item modifiers.

The recipe now records a reviewed `verification.profitBlockedReason`. The shared
publisher retains cost and observed asks but refuses profit/ROI and records the
reason. The public read boundary preserves it; changing recipe content invalidates
old accepted evaluations. This does not assert that every extra random modifier
has a known premium, nor that two asking sellers prove sale probability.

Fear's cheapest observed item additionally has minion critical chance; that extra
modifier's premium has not been measured. The RF floor has incidental stats and
the hybrid damage components of the required support affixes. Their remaining
figures are conditional asking-price comparisons, not validated realized returns.
Mean spending gives only about 63–65% probability of a completed target under the
independent-reroll model; it is not a guaranteed budget. In-game expenditure,
executed sales, empirical frequencies and Annul recovery remain unverified.

## UI changes and verification

- The wand image measured 36×108 px inside a 42×42 frame. Explicit zero-minimum
  grid tracks contain tall artwork without clipping the sibling tooltip.
- `/` is Profitability; `/recipes` is a separate catalogue of all 26 craft targets,
  with name/target search, class filtering, and links to ingredients and steps.
  It retains recipes with absent or negative profitability and ignores ROI filters.
- Recipe details show base consumption and each material cost multiplied by
  expected executions, the ROI formula (10 div cost / 12 div ask = 20%), and a
  mean-budget explanation. Past material quotes are labelled when stale.
- A broad descendant-span CSS rule was narrowed to direct children so ingredient
  icons and money values retain their own layout rules.
- 572 unit tests plus the native-runtime self-check passed; 140 PostgreSQL
  integration tests passed. Build, lint, 26-recipe validation passed.
- Browser assertions passed on the profitability table, recipe index and detail
  at 320, 390, 768 and 1440 px: all images loaded, no icon escaped its frame,
  no page overflow. Class/search filtering, recipe navigation and browser Back
  passed. Deterministic design scan returned no findings.
- Changed-file formatting passed. The repository-wide formatter reports 34
  unchanged baseline files (including generated migration metadata); they were
  left outside this fix.
- Independent code review found two UX issues (overpromised material search and
  CSS cascade on the library filters); both were corrected.

Physical-device rendering and screen-reader speech were not tested.
