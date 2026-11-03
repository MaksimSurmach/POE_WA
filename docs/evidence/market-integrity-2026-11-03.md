# Market integrity: unrealistic ROI diagnosis (2026-11-03)

Base: `03f9713`. Scope: costing, sale-price evidence and publication acceptance
for published recipe economics. No ROI ceiling was introduced.

## Observation

The local `/api/catalog` response (read-only, `127.0.0.1:3000`, Allflame) showed
`minion-fossilised-shield-greed` as `status: success`, `confidence: low`, with a
cost of 869.28c, an ask of 19,795c, a profit of 18,925.72c and an ROI of 2177.17%.
The ~9000% value reported earlier could not be reproduced from current data. It
fits the same defect class, but that is not proven.

All published recipes with a large positive ROI shared one property: Trade
returned exactly one comparable listing.

| Recipe                            | ROI     | Cost     | Ask      | Comparable listings | Listing age |
| --------------------------------- | ------- | -------- | -------- | ------------------- | ----------- |
| minion-fossilised-shield-greed    | 2177.17 | 869.28   | 19,795   | 1 (total 1)         | 64 days     |
| suppression-gloves-zeal           | 434.83  | 2,590.80 | 13,856.5 | 1 (total 1)         | 2 days      |
| suppression-boots-loathing        | 260.61  | 329.36   | 1,187.7  | 1 (total 1)         | 68 days     |
| two-handed …fuel-the-fight…       | -51.59  | 6,546    | 3,168.8  | 1 (total 1)         | 93 days     |
| rf-fire-trap-level-20             | 164.18  | 1,198.88 | 3,167.2  | 20 of 33 (sorted)   | 62 days     |
| minion-convoking-wand-four-fossil | 143.08  | 2,607.16 | 6,337.6  | 19 of 87 (sorted)   | 79 days     |

The single shield listing is a superset item. It has the target mods plus 36%
minion damage, Intelligence and Lightning Resistance, it is item level 80, and it
had been listed for 64 days. Its ask is one seller's price for a better item, not
evidence of what the authored target sells for.

## Confirmed defect

`apps/server/src/catalogPublisher.ts` took the `cheapest` estimate from any
non-empty comparable sample. It published profit, ROI and `status: success` even
when that sample held one seller. With one seller, "cheapest ask" is just that
seller's ask, so there is no competition behind it. Reporting a profit from it
was unsupported, even though the arithmetic was correct. `confidence: low` was
set, but the ROI still reached the catalog card and ranked first under ROI
sorting.

### Fix

- Profit and ROI are computed only when the comparable sample (sellers already
  deduplicated by `aggregateMarketListings`) has at least
  `minimumComparableSellers = 2` independent sellers.
- Below that, the evaluation keeps the cheapest ask and the expected craft cost
  for transparency. It sets `profit` and `marginPercent` to `null`, sets `status`
  to `partial` (so `lastSuccessfulAt` is `null`), and records
  `methodCost.saleEvidence = { comparableSellers, minimumComparableSellers, status: 'insufficient_sellers' }`.
- Accepted evaluations record `saleEvidence.status: 'accepted'`.
- The recipe page's pricing note now states the two-seller requirement. The
  catalog card already shows "Verified sellers".

Two sellers is the smallest sample in which the cheapest ask competes with
another independent ask. It matches the existing pipeline contract, which
expects profit from two distinct sellers (`recipePipeline.test.ts`), and it does
not suppress large ROI that rests on deeper samples (rf-fire-trap-level-20,
convoking wand).

### Expected effect on the observed data (not re-run live)

Under the new rule, shield, zeal gloves, boots and the two-handed cluster would
publish as `partial` with no profit or ROI. rf-fire-trap-level-20 (164%) and the
four-fossil wand (143%) are unchanged, because each rests on a sorted sample of
at least 19 sellers.

## Rejected hypotheses

- **Expected material usage.** For every recipe, authored `expectedExecutions`
  matches `1/p` within calculator rounding (shield: p = 0.00594, 1/p = 168.35,
  169 executions). The shield cost reconciles exactly:
  1c base + 169 × 5.12c Deafening Essence of Greed (poe.ninja, bulk) + 3c bench = 869.28c.
- **Chaos/divine conversion.** Converted asks are consistent multiples of one
  rate, about 197.95 c/div (19,795 = 100 div; 1,187.7 = 6 div; 3,167.2 = 16 div).
  The direction is correct (divine × rate). Rate freshness and league checks
  already exist in `convertMarketQuote`.
- **ROI formula or decimal precision.** `profit / cost × 100` over Decimal
  arithmetic, with cost = base × expectedBases + expected materials, is correct.
- **Base comparability.** The starting base is queried at exactly item level 60
  (134 results, cheapest 1c). Finished comparables use a minimum item level by
  design.
- **Confidence condition `!base?.sortedSampleComplete`.** This was introduced
  deliberately in `2167588` to downgrade confidence when the base cost comes from
  a partial sample. It is not inverted.
- **Listing-age filter.** Many legitimate cheapest asks in deep samples are
  more than 50 days old. An age cut-off would be an arbitrary heuristic, and the
  defect is fully explained by sample depth.

## Unresolved risks

- Superset comparables (more mods than the target) can still inflate asks in
  deep samples. Fixing that needs stricter target matching, outside this unit.
- Asking prices are not sale evidence. Accepted ROI is still indicative, as the
  UI states.
- Evaluations persisted before this fix keep their ROI until re-evaluated or
  expired by the quote-age policy, including when reused as a stale fallback.
- Cluster recipes in the local catalog exposed no snapshot listings, so their
  seller counts could not be checked from the API. Any with fewer than two
  sellers will now publish as `partial`.
