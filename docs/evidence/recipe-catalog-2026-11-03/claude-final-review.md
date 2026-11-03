Reviewed baseline: 60ad6f7, before the later current CoE verification of two simple glove methods.

No reproducible correctness blocker found in the reviewed scope. There are two operational risks and two missing guards. I read code and data only; I ran no tests and checked no live endpoints. This is not an approval.

## Risks

**1. Deploy order can stop refresh for the whole catalog (medium)**

- **Where:** `apps/server/src/process.ts:116` syncs recipes at startup. `apps/server/src/refreshPlanner.ts:252-261` calls `marketDependencies` for each recipe with no try/catch.
- **Scenario:** the new code starts before someone manually runs `trade-mappings:import .../recipe-catalog.json`. `resolveBase` returns `TRADE_MAPPING_MISSING`, `generateRecipeMarketQuery` throws, and `planCatalogRefresh` fails.
- **Impact:** no refresh for any recipe, including the two verified cluster recipes.
- **Smallest fix:** make "import `recipe-catalog.json` before deploy" a required runbook step. The code fix is a per-recipe catch in `buildDependencies`.

**2. One failure blocks the whole publication (medium, existing rule, now affects 15 recipes instead of 2)**

- **Where:** `apps/server/src/catalogPublisher.ts:348-350` publishes only if at least 95% of recipes complete. With 15 recipes that means 15/15. Stale fallbacks count as failed.
- **Scenario:** one new recipe's target snapshot is missing after a failed fetch. `resolveMarket` at line 461 is not wrapped in `optionalMarket`, and a new recipe has no earlier evaluation to fall back on. The cycle fails.
- **Impact:** the previous catalog stays published, so no data is lost. But no new catalog publishes until every recipe succeeds in the same cycle.
- **Smallest fix:** accept this explicitly, or leave unverified recipes out of the threshold count.

## Missing guards (data is correct today)

**3. Exchange IDs are never validated (low)**

- **Where:** `apps/server/src/tradeMappings.ts:116-126` checks resource names against `/items` only, never `payload.exchangeId`. `recipeCatalog.test.ts:51-54` uses only the receipt's resource names.
- **Today:** I compared all 18 by hand (`scour`, `wild-lifeforce`, `chaos`, …) and they match `trade-identities.json`. The Ninja side matches on `detailsId === canonicalId` (`catalogPublisher.ts:554`), which is the separate slug as intended.
- **Smallest fix:** in `recipeCatalog.test.ts`, assert every resource `exchangeId` is in `identities.resources[].id`.

**4. A condition's `kind` is not tied to its Trade stat type (low)**

- **Where:** `resolveTarget` looks up by `modId` only and ignores `kind` (`tradeMappings.ts:183-185`).
- **Scenario:** `kind: "fractured"` with `mod:suppression` would silently search for the explicit stat. The current recipes all use the separate `mod:fractured-*` IDs, so nothing is wrong today.
- **Smallest fix:** a catalog test that `fractured` maps to `fractured.*` and `implicit` maps to `implicit.*`.

## Checked and correct

- **Economics stay unavailable for the new 13:** `evidenceValid` requires verified status plus `expectedExecutions` and `baseConsumption` (`catalogPublisher.ts:585-591`), and `compareCraftWithAsk` returns null without `expectedBases`. So expected cost, profit and margin are null. `materialsPerAttempt` is shown only for one-step methods and is a real per-attempt cost.
- **Chaos Orb fee:** its query is null, the planner skips it (`refreshPlanner.ts:263`), and the price is exactly 1 chaos (`catalogPublisher.ts:532-549`). There is no chaos→chaos exchange query.
- **Fractured handling:**
  - Starting `kind`/min/max carry into the starting-base query (`recipeMarket.ts:136-143`), and the schema rejects min > max.
  - Matching compares stat ids, not the shared alias key (`beltComparability.ts:140`), so an explicit chaos resistance (alias `chaos_resistance`) cannot satisfy the fractured 34/34 requirement.
  - Missing or ambiguous modifier evidence never counts as a MATCH.
- **Existing hashes unchanged:** the new sort key in `normalization.ts:54-57` leaves existing hashes alone, because undefined fields are dropped and the target signature uses `startingMods: []`.
- **Sync:** no recipe files were removed, so nothing gets disabled, and a hash failure doesn't disable an existing row.
- **Normalizer coverage:** all 24 mod external IDs have an entry in `tradeStatMappings`. `jagged-fossil` appears in both manifests with the same `externalId`, so the import upserts one row.
- **Scope:**
  - The Hunter bow is not in `recipes/`. Its leftover stat entries (socketed gems, support gems, chaos DoT multiplier) are display-only and unused.
  - All 16 Sheet leads are kept. C006, C008–C010 and C012–C016 stay unpromoted leads.
  - The `#ERROR!` raw cells are kept separate from the recovered formula text.

## Not verified by me

- **Game data:** whether the life floors are reachable (gloves 100, belt 130 at ilvl 85), the Fossilised Spirit Shield's native minion-damage implicit, the essence value ranges, and the bench and Harvest costs. If any of these is wrong, the recipe finds zero matches; it does not produce false ones.
- **Ninja coverage:** whether Ninja's Currency/Essence/Fossil/Resonator pages contain the Lifeforce, Ember and Ichor lines. If not, those materials fall back to the exchange top-of-book price, which has no economic effect for unverified recipes.

Disposition: import-before-restart order is explicit in the runbook; the existing95%publication threshold remains an acknowledged gate. Exchange-ID and implicit/fractured-origin archive guards were added to recipeCatalog.test.ts. The review did not run tests or grant formal GitHub approval.
