**PR #30 review: no P0, P1 or P2 defects found.** There is one P3 finding and three questions I couldn't settle.

**Reviewed head:** `29568e194b607ce18336a57e266852dd3a29fc7e` (base `03f9713`, 17 commits, 117 files)

**Scope:** I read the production code in full: `catalogPublisher.ts`, `resourceViews.ts`, `recipeMarket.ts`, `marketCollection.ts`, `marketJobProcessor.ts`, `refreshPlanner.ts`, `poeTrade.ts`, `tradeCompatible.ts`, `marketCurrency.ts`, `marketEconomy.ts`, `craftingPrices.ts`, `api.ts`, the evaluation save path, migration 0024 and `priceHistoryRepository.ts` (write, rollup and retention SQL). I also read the domain `calculateCostScenario`, the contracts, both Quicksilver recipes, the convoking wand recipe change, the mapping and presentation data, and on the web side `catalog.ts`, `CatalogTable`, `App`, `RecipePage`, `RecipeLibraryPage`, `PohxRecipePage` and `ItemTooltip`. Finally I read `scripts/local-runtime.sh` and its test, plus the removed and trimmed tests.

## Checked and correct

- **Profit and ROI:** profit = cheapest accepted ask − (base × expected bases + Σ expected executions × materials). ROI is computed against cost. Reroll and finishing counts are summed per material.
- **Quicksilver recipes:**
  - The probabilities match the counts: 1/p = 9105 and 3015; Enkindling 250/650/11 gives 28.6.
  - The starting base is pinned to ilvl 85 (min = max) with quality 20 and is counted once.
  - The Enkindling step is costed.
  - The "reduced" duration roll is parsed as a negative value, so it falls inside the target's −27…−23 range.
- **Profit is withheld when the sale price isn't trustworthy:** any of these blocks profit and ROI:
  - the output search isn't fully collected
  - an ask in a currency we can't convert, or an unconverted divine ask that matches the target
  - a conversion rate that is too old or from another league
  - fewer than 2 distinct sellers (duplicate accounts are removed first)
  - the recipe's `profitBlockedReason`

  This happens both when the catalog is published and again when it is read, so evaluations saved before this PR are covered too.

- **Freshness:** `oldestInputAt` and `expiresAt` include every input actually used (output, base, trade and poe.ninja materials, conversions). The stale fallback keeps the old expiry, and expired evaluations show no cost or profit.
- **Price history:** it is written in the same transaction as the evaluation and deduplicated per source snapshot. The trends pages show history only and never derive ROI from it. `pg_input_is_valid` is fine on the PostgreSQL 17 the project targets.
- **Runtime script:** start goes postgres → app → web; stop goes prices-on-login → app → web → postgres, waits for each process to exit, and is safe to repeat. The plist files live outside the folders macOS loads at login.
- **Pohx calculator:** blank or invalid inputs make the result null rather than zero, a quantity of 0 skips that material, and expired quotes are ignored.

## Findings

**P3 — outputs with more than 100 listings are re-fetched every refresh and can never be priced**

- **Where:** `apps/server/src/marketCollection.ts:236-244` together with `apps/server/src/refreshPlanner.ts:129-141`.
- **Trigger:** a crafted-item output search that includes other currencies and reports more than 100 results.
- **What happens:**
  - The collector fetches details for 100 listings (about 10 rate-limited fetch requests plus the search) and marks coverage partial.
  - `resolveMarket` and `prepareResult` then throw those listings away, because this kind of output requires complete coverage.
  - The planner treats any non-complete snapshot as a cache miss, so this repeats on every refresh.
  - The result: trade-API budget is spent on every cycle, refreshes get slower, and the output stays unpriced. This is safe for money (no profit is invented); it only wastes requests.
- **Smallest repair:** in the collector, skip the detail fetches when `reportedTotal > 100` for this target type and return the partial batch. Alternatively, let the planner count a fresh snapshot with `totalResults > 100` as a cache hit.

## Unresolved questions (not verified defects)

1. **Base price may often be unavailable** (`catalogPublisher.ts:791-803`, `:435`). The starting-base search also includes other currencies. A single ask in an unconvertible currency (alch, fusing, etc.) anywhere in the 20-listing base sample makes the base unavailable, so expected cost is null and the recipe stays partial. This is the conservative choice, but it could leave cheap-base recipes permanently unpriced. The flask evidence file shows a priced base, so I didn't see this happen.
2. **Recipe probabilities:** the Craft of Exile tier weights, the 60–70 Enkindling roll range, and whether Alterations alone suffice can't be checked from the repo. I verified only that the numbers are internally consistent.
3. **Runtime setup:** the plist contents (`KeepAlive`/`RunAtLoad`) and any leftover `~/Library/LaunchAgents` entries are outside the repo and weren't inspected, as instructed. `status` also doesn't report `prices-on-login`.

## Inspection limits

- I ran no tests and relied on the CI result you reported.
- Not read in full: the CSS files, `PriceTrendChart`/`MarketTrendsPage` rendering, the read queries in `priceHistoryRepository`, the drizzle snapshot JSON, the `pohxGuides.json` text against pohx.net, or the evidence and docs.
- Of the test changes, I spot-checked the business tests and the removed tests. The `errors.test.ts` change only trims it; the redaction test is still there.
