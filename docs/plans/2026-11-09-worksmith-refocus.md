# Worksmith refocus: implementation plan (revision 2)

Status: **ready for execution, Phase 1 first**. Baseline: `master` at `b0d3c13`.
Revision 2 of 2026-11-09 replaces revision 1 in full. This file is the
authoritative copy. Background evidence: `docs/worksmith-review-2026-11-09.html`.

Executors: work **one task at a time, in ID order within a phase**. Each task is a
self-contained card. Read "Rules for executors" once, then the card.

## Outcome

The homepage answers: **what is worth crafting now, by which method, and what
Trade data supports it.**

End-state acceptance:

1. A recipe with valid evidence shows mean cost, sale ask, expected profit, ROI,
   the p50 and p90 budget to craft one item, and an evidence grade A/B/C.
2. A recipe whose price comparison is invalid shows no profit and states why.
3. Recipes that target the same result appear together and are ranked by expected profit.
4. A dedicated collector instance gathers Trade and poe.ninja data. It does not
   poll the database on a short timer. A second collector started by mistake waits.
5. The homepage shows the collector's last run and has a **Run now** button. No admin page.
6. Market activity (inferred from listings) is shown separately from the owner's
   confirmed sales and from any profit estimate.

## Decisions (final unless marked)

| # | Decision | Decided by |
|---|---|---|
| D1 | Output prices come from the PoE Trade website API under the owner's account; currency and materials from poe.ninja. Account risk accepted. | Owner, 2026-11-09 |
| D2 | Three services: **app** (API + web UI), **collector** (dedicated collection instance), **PostgreSQL** (separate service). Home Assistant add-ons are retired. | Owner, 2026-11-09 |
| D3 | **Keep Playwright** and username/password login. Reuse the stored session cookie while it is valid; use Playwright only to re-authenticate. | Owner, 2026-11-09 |
| D4 | pg-boss may be removed once the replacement provides scheduling, retries and recovery without frequent database polling (design in Phase 2). | Owner, 2026-11-09 |
| D5 | Old signals and capital allocator are removed (Phase 5). Accurate calculations and a working collection pipeline come first. | Owner, 2026-11-09 |
| D6 | No admin page. Worker status and Run now live on the homepage. | Owner, 2026-11-09 |
| D7 | Invalid price comparisons stay **hard-blocked**. Grades A/B/C describe only the quality of valid evidence. | Review finding 1 |
| D8 | Expected profit uses **mean** cost. p50 and p90 are shown as the budget needed to craft one item. | Review finding 5 |
| D9 | Two collectors coordinate through one PostgreSQL session advisory lock: leader collects, standby blocks on the lock. | Proposed in revision 1, unchallenged |

## How the review findings are addressed

| Finding | Where |
|---|---|
| 1. Hard blocks vs grades | Definitions below; task P1-04 |
| 2. Check every caller; Go runner config and belt fixtures have consumers | Rule R3; P1-02 is limited to zero-caller code; Go, runner config and belt code move to Phase 5 behind caller gates |
| 3. Switch worker and read path together; persist Run now before 202 | Phase 2 cutover sequence; P2-06, P2-09, P2-10 |
| 4. Capture history; inferred exits vs confirmed sales; activity vs own profit | P2-02 schema (`listing_events`); Phase 3 |
| 5. One end-to-end comparison in Phase 1 | P1-07, P1-08, P1-09 |

## Definitions used throughout

**Hard block** — the comparison is not valid, so no profit or ROI is produced.
The row shows the reason. Hard blocks (all exist in the code today and stay):

| Code | Condition | Where enforced today |
|---|---|---|
| HB1 | Recipe has `verification.profitBlockedReason` (example: the +2 wand recipe, whose priced listings carry paid finishes the recipe does not produce) | `catalogPublisher.ts:643-654`, status `unverified_output_value` |
| HB2 | A listing does not match the recipe target; it is excluded. Zero matching listings means no sale ask. | `recipeMarket.ts` `matchingRecipeListings` (uses `analyzeBeltSnapshot`, status `MATCH`) |
| HB3 | A listing price cannot be converted with a verified, fresh exchange rate | `catalogPublisher.ts` `resolveMarket` → `currencyAvailable`, status `unavailable_currency` |
| HB4 | Mixed-currency output search without complete coverage: the cheapest converted ask is unknowable | `recipeMarket.ts:283` `requiresCompleteOutputCoverage`; `resolveMarket` empties the aggregation |
| HB5 | Any input is past `expiresAt` or `maximumQuoteAgeMs` | `resourceViews.ts` `currentEvaluation` |
| HB6 | Cost side is not established: recipe not verified for the league, evidence patch mismatch, a material has no price, or a material price is not bulk-supported | `catalogPublisher.ts` `evidenceValid`, `bulkSupported` |

**Grade** — quality of evidence that passed every hard block:

| Grade | Rule (first match from the top) |
|---|---|
| C | exactly 1 distinct seller |
| B | 2–4 distinct sellers; or coverage is a validated sorted sample (`sortedSampleComplete`) and not `complete`; or the oldest input is older than `freshnessWarningMs`; or an outlier ask was ignored |
| A | 5+ distinct sellers, coverage `complete`, inputs fresh, no outlier ignored |

**Inferred exit** — an item that left Trade listings under the Phase 3 rules.
It is never called a sale. **Confirmed sale** — a sale the owner recorded in My
Factory. The two are stored and displayed separately.

## Rules for executors

- **R1 Baseline.** Before the first edit of a task, on a clean tree:

  ```bash
  pnpm install --frozen-lockfile
  pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm recipes:validate
  ```

  Tasks that touch `apps/server` persistence or `tests/browser` also run:

  ```bash
  # throwaway PostgreSQL 17 on 127.0.0.1:54324, database poe_worksmith_test
  set -a; . ./.env.test.example; set +a
  (cd apps/server && node dist/migrate.js)
  pnpm test:integration && pnpm test:e2e:backend && pnpm exec playwright test
  ```

  Expected at `b0d3c13`: 818 unit, 169 integration, 8 backend E2E, 10 browser, 28 recipes.
  Integration tests fail with `relation … does not exist` if the migrate step is skipped.
- **R2 One task, one branch, one PR.** Branch `refocus/<task-id>-<slug>` from current `master`.
- **R3 Caller check before deleting or renaming anything.** Run, in `bash` (zsh expands unquoted globs):

  ```bash
  bash -c 'grep -rnE "<symbol-or-filename>" apps packages scripts services tests .github Dockerfile compose.yaml package.json --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.json" --include="*.yml" --include="*.yaml" | grep -v "/dist/"'
  ```

  Delete only if every hit is the definition, its own test, or a file this task also deletes. Any other hit: **stop and report**.
- **R4 Tests.** Write the failing test first. Never delete or weaken a test that covers behavior still in the product. When a task changes intended behavior, update the test and say so in the PR.
- **R5 No scope growth.** Do not refactor, rename or reformat outside the listed files.
- **R6 Stop rule.** If a "verify first" assumption is false, or a stop condition is met, make no further edits; report what you found and which line of this plan it contradicts.
- **R7 Line numbers** are from `b0d3c13`. Locate code by the quoted symbol, not the number.
- **R8 Progress.** After merge, append one line to the Progress log at the end of this file: task ID, PR, date, deviations.

## Phases

| Phase | Shippable outcome | Depends on |
|---|---|---|
| 1 | Correct, graded numbers on the existing pipeline, and one target compared across two methods on one page | — |
| 2 | Collector instance, new storage with capture history, read path switched together with the worker, Run now on the homepage | 1 |
| 3 | Reprice / disappearance / relist classification; market activity shown separately | 2 |
| 4 | Homepage ranking, recipe page, admin page removed | 2 (3 for activity columns) |
| 5 | Old pipeline, pg-boss, Go service, signals, allocator and unused tables removed | 2–4 stable for 7 days |
| 6 | Catalog growth | 1, 4 |

---

# Phase 1 — correct numbers and one real comparison

No migrations. No change to collection, scheduling or deployment.
Dependency order: `P1-01 → P1-02 → P1-03 → P1-04 → P1-05 → P1-06 → P1-07 → P1-08 → P1-09`.
P1-02 and P1-06 are independent of the others and can run in parallel with P1-03..05.

## P1-01 — Record the baseline

- **Why:** every later task compares against known-good counts.
- **Behavior change:** none.
- **Steps:** run R1 in full (both blocks). Append the six counts and the commit hash to the Progress log.
- **Acceptance:** counts match R1, or the differences are listed.
- **Stop:** any baseline failure. Do not start Phase 1 on a red baseline.

## P1-02 — Remove code with zero production callers

- **Why:** less code to keep correct. Limited to what was verified dead on 2026-11-09.
- **Behavior change:** none.
- **In scope:**

  | Remove | Known references (all must be removed or are tests of it) |
  |---|---|
  | `packages/domain/src/probability/` (6 files incl. `probability.test.ts`) | export in `packages/domain/src/index.ts`; probability-cache member of the `Repositories` type in `packages/domain/src/repositories.ts`; its implementations in `packages/domain/src/inMemoryRepositories.ts` and `apps/server/src/repositories/postgresRepositories.ts`; the matching cases in `postgresRepositories.integration.test.ts` |
  | `calculateExpectedCraftCost` in `packages/domain/src/recipeEconomics.ts` | none |

- **Explicitly out of scope (have live callers; handled in Phase 5):**
  - `services/market-collector/` and `marketCollectionRunner` (`config.ts:136`; used at `process.ts:81,261,283,347,349,565`, `marketCollectionSource.ts:36,118`, `marketResearchApi.ts:827,853`).
  - Tables `market_collection_requests|workers|ownership` (read or written at `process.ts:272-281`, `marketCollectionRepository.ts:45-63,150`).
  - `beltComparability.ts` (`analyzeBeltSnapshot` is the live listing matcher, imported by `recipeMarket.ts:16`), `beltDemoFixture.ts` (fixture for 9 test files covering active collection and currency code), `beltOpportunity.ts` (called at `marketResearchApi.ts:432`).
  - `calculateRecipeEconomics` (called by `beltOpportunity.ts`).
  - Price estimator strategies (`medianTopFive` is read by `marketJobProcessor.ts`).
  - Table `craft_probability_results` and `resetIntegrationDatabase.ts` (leave; Phase 5).
- **Verify first:** R3 for `createProbabilityService`, `ProbabilityService`, `probability/`, `calculateExpectedCraftCost`.
- **Tests:** existing suites only.
- **Acceptance:** R1 (both blocks) passes; the diff contains deletions and import fixes only.
- **Stop:** any caller outside the table.

## P1-03 — Outlier-guarded sale ask

- **Why:** the sale price is the single cheapest ask (`catalogPublisher.ts:623`, `estimators.find(({ id }) => id === 'cheapest')`). One mispriced listing decides profit.
- **Behavior change:** with 5 or more distinct sellers, leading asks below half the median of the five cheapest are ignored. Fewer than 5 sellers: unchanged.
- **Files:**
  - `packages/domain/src/priceEstimators.ts` — add:

    ```ts
    export function estimateSaleAsk(aggregation: MarketAggregation): Readonly<{
      price: ProviderMoney | null;
      basis: 'cheapest' | 'cheapest-after-outlier' | 'none';
      ignoredOutliers: number;
    }>
    ```

    Rule: `listings` in `MarketAggregation` are already sorted ascending and de-duplicated by seller. If `sampleSize >= 5`, let `m = Number(aggregation.medianTopFive.amount)`; skip leading listings with price `< 0.5 * m`; return the first remaining. Otherwise return `aggregation.cheapest`. Empty: `{ price: null, basis: 'none', ignoredOutliers: 0 }`.
  - `packages/domain/src/priceEstimators.test.ts` — tests below.
  - `apps/server/src/catalogPublisher.ts` — in `evaluateFreshRecipe`, replace the `outputEstimate` lookup with `estimateSaleAsk(output.aggregation)` (keep the `output?.currencyAvailable` guard). Add `saleBasis` and `ignoredOutliers` to the `saleEvidence` object.
- **Callers:** `outputEstimate` is used only inside `evaluateFreshRecipe`. `MarketAggregation` is unchanged.
- **Verify first:** `aggregateMarketListings` still returns `listings` sorted and seller-deduplicated (`priceEstimators.ts`, `deduplicateSellers`).
- **Tests (write first):**
  1. asks 1, 100, 105, 110, 120, 130 (six sellers) → `100`, `cheapest-after-outlier`, 1.
  2. asks 100, 105, 110 → `100`, `cheapest`, 0.
  3. two listings from one seller + one other → sample size 2, cheapest of the two sellers.
  4. no listings → `none`.
  5. Publisher: target snapshot with asks 1, 100, 105, 110, 120 from five sellers → `estimatedSalePrice` is `'100'`, `saleEvidence.ignoredOutliers` is 1.
- **Acceptance:** tests pass; R1 first block passes; existing publisher expectations with fewer than 5 sellers are unchanged.
- **Stop:** an existing test with 5+ sellers changes its expected sale price for a reason other than the outlier rule.

## P1-04 — Hard blocks stay, valid evidence gets a grade

- **Why:** profit is withheld for cases that are valid but thin (one seller; validated sorted sample), which blanks most rows. Invalid comparisons must stay blocked (D7).
- **Behavior change:**

  | Case | Before | After |
  |---|---|---|
  | HB1–HB6 | no profit | no profit, unchanged, reason shown |
  | 1 distinct matching seller | status `insufficient_sellers`, no profit | status `accepted`, profit shown, grade C |
  | 0 matching sellers | `insufficient_sellers` | unchanged |
  | Non-mixed target, coverage not `complete`, `sortedSampleComplete` true | `insufficient_coverage`, no profit | `accepted`, grade at most B |
  | `confidence` | `output?.coverage === 'complete' && !base?.sortedSampleComplete ? confidence(n) : 'low'` (`catalogPublisher.ts:756`) | derived from grade: A→`high`, B→`medium`, C or blocked→`low` |

- **Files and callers:**
  - `packages/domain/src/recipeEconomics.ts` — add pure function:

    ```ts
    export function gradeSaleEvidence(input: {
      sellers: number;
      coverage: 'complete' | 'partial' | 'unknown';
      sortedSampleComplete: boolean;
      oldestInputAgeMs: number;
      freshnessWarningMs: number;
      ignoredOutliers: number;
    }): { grade: 'A' | 'B' | 'C'; reasons: string[] }
    ```

    Reasons are short fixed strings: `"1 seller"`, `"2–4 sellers"`, `"sorted sample, not full coverage"`, `"inputs older than warning age"`, `"outlier ask ignored"`.
  - `apps/server/src/catalogPublisher.ts` `evaluateFreshRecipe`:
    - `saleEvidence.status`: keep the HB1, HB3 branches. Change the coverage branch to block only when `requiresCompleteOutputCoverage(targetDependency.query.query)` is true **or** `output.sortedSampleComplete` is false. Change the seller branch to `comparableSellers >= 1 ? 'accepted' : 'insufficient_sellers'`.
    - When status is `accepted`, add `grade` and `gradeReasons` to `saleEvidence`.
    - Replace the `confidence:` expression as in the table. Delete the local `confidence()` helper if it has no other caller.
    - `evaluateAndPublishCatalog` needs `freshnessWarningMs`: add an optional option beside `maximumQuoteAgeMs` (default 60 minutes) and pass it from the caller that already passes `maximumQuoteAgeMs` (R3 on `maximumQuoteAgeMs:` to find it; expected in `process.ts` and `entrypoints/publishTradeCatalog.ts`).
  - `apps/server/src/resourceViews.ts` `withoutUnsupportedProfit`: if `saleEvidence.grade` is present, return the evaluation unchanged (the publisher already decided). Otherwise keep today's logic for evaluations stored before this task. `currentEvaluation` (HB5) is not touched.
  - `packages/contracts/src/index.ts`: on the recipe evaluation schema (the object containing `confidence` near line 257) add `grade: z.enum(['A','B','C']).nullable().optional()` and `gradeReasons: z.array(z.string()).optional()`.
  - `apps/server/src/resourceViews.ts` `toEvaluation`: pass `grade` and `gradeReasons` from `methodCost.saleEvidence`.
  - `apps/web/src/CatalogTable.tsx`: beside profit render the grade (`A`, `B`, `C`) with `gradeReasons` joined as the `title` and listed in the "Market evidence" cell. When `profitBlockedReason` exists keep the existing "ROI withheld" text. Replace the fallback "Updating / Source details unavailable" with "No price collected yet" when `evaluation.status === 'loading'`.
- **Verify first:**
  - `saleEvidence.status` values in `evaluateFreshRecipe` are exactly `unverified_output_value`, `unavailable_currency`, `insufficient_coverage`, `accepted`, `insufficient_sellers`.
  - `resolveMarket` returns an empty aggregation for HB4 (the `listings: … ? [] : listings` expression). If it does not, HB4 is not enforced where this plan says: stop.
- **Tests:**
  1. `recipeEconomics` unit: one case per row of the grade table, and precedence (1 seller + complete → C).
  2. Publisher: change the existing `it.each` "withholds profit and ROI when the sale ask rests on %s" to expect profit as a number, `status: 'success'`, `saleEvidence.grade: 'C'`, `confidence: 'low'`. State this change in the PR.
  3. Publisher: recipe with `profitBlockedReason` and five sellers → `profit: null`, status `unverified_output_value`, no `grade` (HB1 regression test; add if absent).
  4. Publisher: mixed-currency target with partial coverage → `profit: null` (HB4; keep the existing test).
  5. Publisher: five sellers, complete, fresh → grade A, `confidence: 'high'`.
  6. `resourceViews.test.ts`: expired evaluation → nulls (HB5 unchanged); evaluation with `grade: 'C'` and one seller → profit preserved.
  7. `CatalogTable.test.tsx`: renders the grade and the reasons; renders "ROI withheld" for a blocked recipe.
- **Acceptance:** all listed tests pass; R1 both blocks pass; no test of HB1–HB6 was removed.
- **Stop:** making a test pass would require producing profit for any HB case.

## P1-05 — Budget to craft one item (p50, p90)

- **Why:** the catalog shows the mean only. For p = 0.000179 the mean is 5,586 attempts, the median 3,872, and one run in twenty needs more than 16,700.
- **Behavior change:** each evaluation with exactly one probabilistic step carries `budget: { p50, p90 }` for one finished item. Mean cost, profit and ROI are unchanged (D8).
- **Files:**
  - `apps/server/src/catalogPublisher.ts` `evaluateFreshRecipe`, after `materialEconomics`:
    - Find steps with `success.probability` in (0, 1). If exactly one, and `expectedCraftCost` is not null:
      - `perAttemptCost` = that step's summed material `costPerAttempt` from `materialEconomics.steps`.
      - `setupCost` = `expectedCraftCost` − `perAttemptCost × expectedExecutions(of that step)`.
      - Call `analyzeIndependentGeometric` (`packages/domain/src/craftingRisk.ts:162`) with `successProbability`, `perAttemptCost`, `setupCost`, `saleValue: '0'`, `budget: '0'`, `withinAttempts: 1`.
      - Its inputs must match `/^(?:0|[1-9]\d*)(?:\.\d{1,16})?$/`. Recipe probabilities are floats such as `0.0016300000000000002`; format with `new Decimal(p).toSignificantDigits(12).toFixed()` and money with `.toDecimalPlaces(8).toFixed()`.
      - Store `methodCost.budget = { p50: costQuantiles.p50, p90: costQuantiles.p90, currency }`.
    - Otherwise `methodCost.budget = null`, with the comment `// ponytail: single geometric stage only; multi-stage budgets need simulateCraftingRisk (Phase 6)`.
  - `analyzeIndependentGeometric` is not exported from the domain barrel if R3 shows no export: add it to `packages/domain/src/index.ts` exports.
  - `packages/contracts/src/index.ts`: add optional `budget: z.strictObject({ p50: price, p90: price }).nullable().optional()` to the evaluation schema, where `price` is the schema already used for `expectedCraftCost`.
  - `apps/server/src/resourceViews.ts` `toEvaluation`: map `methodCost.budget` with the existing `persistedPrice` helper.
  - `apps/web/src/CatalogTable.tsx`: under "Expected cost" show `p50 · p90` in muted text with the label "budget for one".
- **Verify first:** `materialEconomics.steps[n].materials[m].costPerAttempt` exists (`recipeEconomics.ts`, `calculateMethodMaterialEconomics`); today two recipes (`quicksilver-*`) have two probabilistic steps and must yield `null`.
- **Tests:**
  1. Publisher: one step p = 0.5, attempt cost 10, base 100, expected executions 2 → mean 120, budget p50 `110`, p90 `140`.
  2. Publisher: two probabilistic steps → `budget: null`.
  3. Publisher: p = `0.0016300000000000002` does not throw.
- **Acceptance:** tests pass; R1 both blocks; mean cost in every existing test unchanged.

## P1-06 — Catalog validation and drafts

- **Why:** recipe numbers are typed by hand and only schema-checked.
- **Behavior change:** `pnpm recipes:validate` fails on inconsistent recipes; three incomplete recipes leave the active catalog.
- **Files:**
  - `apps/server/src/recipes/loader.ts`: in the directory walk (`readdir(directory, { withFileTypes: true })`), skip directories whose name starts with `_`.
  - Move `minion-leviathan-fear-gloves.json`, `tr-grizzly-aoe-helmet.json`, `lacerate-shaper-recovery-shield.json` to `recipes/_drafts/` (find them with `grep -rl '"status": "unverified"' recipes`).
  - `apps/server/src/recipes/loader.ts` (or a new function called from `loadRecipeCatalog`): after schema validation, for each recipe with `verification.status === 'verified'`:
    - every step with `materials.length > 0` has an entry in `craft.expectedExecutions`, and `craft.baseConsumption` exists;
    - for each step with `success.probability` = p, `|count − 1/p| / (1/p) <= 0.05`;
    - recipe `id` values are unique.
  - Two recipes **may** share `targetSignature`; they must then differ in `craft.method` (deep-equal check). Same signature and same method is an error.
- **Callers:** `loadRecipeCatalog` is used by `validateCatalog.ts`, `syncCatalog.ts`, `synchronizeRecipes.ts` and tests. Sync soft-disables recipes missing from disk (`README.md`), so the three drafts become inactive in the database on next sync; that is intended.
- **Verify first:** at `b0d3c13` all 25 verified recipes pass these rules (checked 2026-11-09: largest deviation is `suppression-gloves-zeal`, 15 vs 14.7, 2%).
- **Tests:** `loader.test.ts`: skips `_drafts`; rejects a verified recipe missing `expectedExecutions`; rejects 100 executions for p = 0.5; accepts two recipes with one signature and different methods; rejects two with the same method.
- **Acceptance:** `pnpm recipes:validate` prints `"recipes":25`; R1 first block; integration fixtures that reference the moved recipes are updated or the task stops.
- **Stop:** a fixture or test depends on one of the three moved recipes for active behavior (R3 on each id). Report instead of editing that test's meaning.

## P1-07 — Second method for one verified target

- **Why:** D8 and finding 5 need one real target with two valid methods. No two recipes share a target today.
- **Chosen target:** physical Large Cluster Jewel, item level 83, 8 passives, rare, with Battle-Hardened, Master the Fundamentals and Furious Assault. Existing method: `recipes/cluster-jewel/physical-large-cluster-jagged.json` (Jagged Fossil, p = 0.00976, 103 executions), signature `3.29.3.3:7bf68c4f67b27b2ae65c467e1d5bfac5`.
- **New recipe:** `recipes/cluster-jewel/physical-large-cluster-chaos.json`: same `base`, `target`, `patch`, and `gameDataVersion`. Use the same starting base constraints with `startingBase.rarity` set to `rare` for Chaos; Jagged keeps `normal`. Price each method with its own starting base quote. Set `craft.method` to `{ "kind": "currency", "currency": "chaos-orb" }` and use one Chaos Orb per attempt. Copy the structure of `shield-attack-large-cluster-fuel-the-fight-heavy-hitter-veteran-defender.json`, which is a Chaos method on a cluster jewel.
- **Required input I1:** the [Craft of Exile calculator](https://beta.craftofexile.com/?game=poe1&ct=calculator&group=4&item=2476.11&details=eyJpIjoiTWV0YWRhdGEvSXRlbXMvSmV3ZWxzL0pld2VsUGFzc2l2ZVRyZWVFeHBhbnNpb25MYXJnZSIsIm0iOltdLCJucyI6MCwicyI6W10sInEiOm51bGwsImwiOjgzLCJyIjoicmFyZSIsImlmIjpbXSwiaXAiOltdLCJlIjpbXSwicCI6e30sImRpIjpbXSwiaWciOjAsIm1zIjowLCJmIjpbImEiXSwicHQiOm51bGwsImF0IjoiYWZmbGljdGlvbl9waHlzaWNhbF9kYW1hZ2UiLCJpZCI6bnVsbH0%3D&method=0%2C5%2C0&flags=&reqs=W3sidCI6ImFuZCIsIm0iOm51bGwsImUiOlt7ImkiOiI1NzQ2IiwidCI6bnVsbCwiYiI6dHJ1ZSwicyI6W10sInAiOm51bGx9LHsiaSI6IjU3NDQiLCJ0IjpudWxsLCJiIjp0cnVlLCJzIjpbXSwicCI6bnVsbH0seyJpIjoiNTc0MiIsInQiOm51bGwsImIiOnRydWUsInMiOltdLCJwIjpudWxsfV19XQ%3D%3D&class=158) displays p = 0.0000869 (0.00869%) and 11,502 expected Chaos Orbs for a rare item level 83 physical Large Cluster Jewel with all three notables. Record the probability, expected executions, and source URL in the recipe, with the URL in `success.evidence` and `expectedExecutions[].evidence`.
- **Behavior change:** the catalog has 26 active recipes; two share one `targetSignature`.
- **Verify first:**
  - `recipeTargetSignature` (`recipeSchema.ts:276`) ignores `method` and `startingMods`, so the new recipe's signature equals the jagged one. The validator prints the expected signature on mismatch.
  - The Trade output query generated for both recipes is identical, so both resolve the same `market_queries` row. Confirm with a unit test calling `generateRecipeMarketQuery` for both and comparing `hashMarketQuery` results.
- **Tests:**
  1. The hash-equality test above (add to `recipeMarket.test.ts`).
  2. Integration (pattern: `catalogPublisher.integration.test.ts`): both recipes, one shared target snapshot with five sellers, separate rare and normal starting base quotes, and material prices → two evaluations, same `estimatedSalePrice`, different `expectedCraftCost`, both with profit and a grade.
- **Acceptance:** `pnpm recipes:validate` prints 26; both tests pass; R1 both blocks.
- **Stop:** the planner or publisher rejects two recipes that share a `market_queries` row. Report the failing constraint.

## P1-08 — Show methods for one target on the same page

- **Why:** finding 5: both results on one page, compared by expected profit on mean cost, with p50 and p90 budgets.
- **Behavior change:** the recipe page gains a section "Methods for this target" when two or more active recipes share the page's `targetSignature`.
- **Files:**
  - `packages/contracts/src/index.ts`: add `targetSignature: z.string().min(1)` to the catalog recipe summary schema (the object returned by `toRecipeSummary`; the detail schema already has it at line 277).
  - `apps/server/src/resourceViews.ts` `toRecipeSummary`: add `targetSignature: definition.targetSignature`.
  - `apps/web/src/RecipePage.tsx`: after the summary numbers, load `apiClient.getCatalog()` once, filter entries by `targetSignature`, and when there are 2+ render a table: Method (`recipe.craftMethod`, linked), Mean cost, Sale ask, **Expected profit** (sale − mean cost, as already computed server-side), ROI, Budget p50, Budget p90, Grade or the block reason. Sort by expected profit descending; rows without profit last. Mark the first row "Best by expected profit". Caption: "Expected profit uses mean cost. Budget is what one finished item can cost you: half of runs finish under p50, nine in ten under p90."
  - `apps/web/src/mocks/` and web test fixtures: add `targetSignature` where catalog entries are built.
- **Callers:** `catalogResponseSchema` is parsed in `apps/web/src/apiClient.ts` and built in `resourceViews.ts`; fixtures in `apps/web/src/mocks/recipeDetails.ts` and tests.
- **Tests:** `RecipePage` component test with two catalog entries sharing a signature: both rows render, order follows expected profit, a blocked method shows its reason and sorts last. A recipe with a unique signature renders no section.
- **Acceptance:** tests pass; R1 first block.

## P1-09 — End-to-end proof

- **Why:** proves Phase 1 on the running app, not only in unit tests.
- **Behavior change:** none in product code; adds a fixture scenario and one browser test.
- **Files:**
  - `apps/server/src/testkit/integrationScenarios.ts` (and `entrypoints/integrationFixtures.ts` if scenarios are registered there): add scenario `two-methods-priced`. It syncs the catalog, stores market queries and fresh snapshots for the shared cluster target (five sellers), its base and both methods' materials, stores a verified Currency exchange snapshot, and runs `evaluateAndPublishCatalog`. Follow `catalogPublisher.integration.test.ts` for the data shape.
  - `scripts/browser-server.mjs`: allow the scenario name from an environment variable, default unchanged.
  - `tests/browser/two-methods.spec.ts`: open the jagged recipe page; assert the "Methods for this target" table has two rows, each with a numeric expected profit, p50 and p90, and a grade; assert the first row is the one with the higher expected profit. Open `/`; assert both recipes show a profit number.
- **Verify first:** whether the existing `all-success` scenario already publishes priced evaluations. On 2026-11-09 the fixture homepage showed dashes for all rows, so assume it does not.
- **Acceptance:** the new browser test passes; the 10 existing browser tests pass; R1 both blocks.
- **Phase 1 is done when** P1-01..P1-09 are merged and the Progress log shows them.

---

# Phase 2 — collector instance, capture history, joint cutover

Tasks are ordered. P2-01..P2-08 are additive and run beside the old pipeline.
P2-09 is the cutover. Nothing old is deleted in this phase.

## Target design

```
app instance (API + web UI)                 collector instance
  GET  /api/catalog  ── reads ──┐             leader: pg_advisory_lock(session)
  POST /api/run                 │             LISTEN worksmith_wake
    1. INSERT run_requests      │             loop:
    2. NOTIFY worksmith_wake    │               read queued run_requests → mark schedule rows due
    3. 202 {requestId}          │               pick due schedule rows (lease), run, write results
  GET  /api/collector/status ───┤               sleep until min(next_due_at, retry_at, rate-limit release)
                                ▼                     or NOTIFY, capped at 15 min
                           PostgreSQL (separate service)
```

**Scheduling without polling.** The collector computes the next due instant from
`collector_schedule` and sleeps on one timer. `NOTIFY` wakes it early. A 15-minute
cap on the sleep is the only periodic database read; it covers a lost
notification after a connection drop. On reconnect it re-issues `LISTEN` and
reads queued requests immediately.

**Retries.** Each schedule row has `attempt` and `retry_at`. A failed run sets
`retry_at = now + min(interval, 2^attempt minutes) + jitter` and increments
`attempt`; success resets both. HTTP 429 or a rate-limit window: sleep until
`rate_limit_states.blocked_until` (existing `GggRateLimitController`). HTTP
401/403 or a challenge: one Playwright re-authentication (D3); if that fails,
set `collector_state.blocked_reason` and stop Trade work until the next Run now.

**Recovery.** A row is leased with `leased_until = now + 10 min`. A capture is
one transaction, so a crash leaves no partial capture. On start the leader
clears expired leases. `SIGTERM` finishes the current target, then exits.

**Two collectors.** Both call `pg_advisory_lock(hashtext('poe-worksmith:collector'))`
on a dedicated connection. The second blocks inside PostgreSQL, with no polling,
and proceeds only if the first connection ends. Leases remain as a second guard.

**Liveness without heartbeats.** The app instance reports "collector connected"
by checking `pg_locks` for that advisory lock. `collector_state` is written only
when a run starts or ends.

**Session (D3).** The collector reads the sealed `POESESSID`
(`repositories/tradeSessionRepository.ts`) and uses it for plain HTTP. On an
authentication failure it starts `PoeTradeSessionManager`
(`providers/poeTradeSessionManager.ts`, persistent profile in
`POE_TRADE_BROWSER_PROFILE_DIR`), logs in, seals the new cookie, clears
authentication denials, and continues. The existing server image already
installs Chromium (`Dockerfile`, `playwright install --with-deps chromium`).

**Complete coverage.** A Trade search returns at most 100 result ids. For a
target reporting more, split by price range until each slice reports 100 or
fewer; cap at 5 slices; beyond that the capture is `partial` and says why.

## Tables added in P2-02 (one additive migration)

| Table | Purpose and key columns |
|---|---|
| `collector_schedule` | One row per unit of recurring work. `id`, `kind` (`trade-target`, `economy`, `league`, `retention`), `key` (unique with `kind`; for Trade the query hash), `league_id`, `payload` jsonb, `interval_minutes`, `next_due_at`, `attempt`, `retry_at`, `leased_until`, `last_started_at`, `last_finished_at`, `last_status`, `last_error`, `enabled`. Index on `(next_due_at) where enabled`. |
| `run_requests` | Persisted Run now. `id`, `scope` (`all` or `recipe`), `recipe_id` null, `requested_at`, `state` (`queued`, `running`, `done`, `failed`), `started_at`, `finished_at`, `summary` jsonb. Partial unique index allowing one `queued` row per scope and recipe. |
| `collector_state` | Single row. `last_run_started_at`, `last_run_finished_at`, `last_run_status`, `last_run_summary` jsonb, `blocked_reason`, `session_checked_at`. |
| `captures` | One per collection of one target. `id`, `schedule_id`, `captured_at`, `reported_total`, `fetched`, `complete` bool, `partial_reason`, `slices`, `fx_snapshot_id`, `duration_ms`. Unique `(schedule_id, captured_at)`. |
| `listings` | Current state of one item in one target. PK `(schedule_id, item_id)`. `seller`, `fingerprint` (hash of base, item level, mods and rolls; excludes price, seller and location), `first_seen_at`, `last_seen_at`, `first_capture_id`, `last_capture_id`, `price_original`, `currency`, `price_chaos`, `indexed_at`, `status` (`active`, `missing`, `gone`), `missed_complete_captures`, `gone_at`, `item` jsonb written once. Indexes `(schedule_id, status)`, `(schedule_id, seller, fingerprint)`. |
| `listing_events` | Append-only history. `id`, `schedule_id`, `item_id`, `capture_id`, `at`, `type` (`first_seen`, `price_changed`, `missed`, `reappeared`, `gone`, `possible_relist`), `from_price_chaos`, `to_price_chaos`, `related_item_id`. Index `(schedule_id, item_id, at)`, `(schedule_id, type, at)`. |
| `recipe_results` | Current evaluation per recipe and league written by the collector. `recipe_id`, `league_id`, `recipe_content_hash`, `evaluated_at`, `result` jsonb validated by one zod schema, PK `(recipe_id, league_id)`. |

`listing_events` is what distinguishes repricing (`price_changed`), disappearance
(`missed` then `gone`) and relisting (`possible_relist`, linked by seller and
fingerprint). Raw provider payloads are not stored per capture; `listings.item`
is written once per item.

## Tasks

| ID | Task | Why / behavior | Files and callers | Verify first | Tests and acceptance |
|---|---|---|---|---|---|
| P2-01 | Design note check | Confirm assumptions on real data before building | none (read-only SQL on the current database) | (a) Trade result `id` is unchanged when the same item's price changes: find items in `market_research_snapshots` seen in 2+ captures with different prices. (b) what fields each stored listing has (seller, indexed time, item mods). | Result written to the Progress log. **Stop** if (a) is false: item identity must be redesigned around the fingerprint. |
| P2-02 | Migration for the seven tables | Storage for schedule, requests and history | `apps/server/src/schema.ts`, new `apps/server/drizzle/00NN_*.sql` via `pnpm --filter @poe-worksmith/server db:generate` | `pnpm db:check:migrations` passes before and after | `schema.integration.test.ts` extended; migration applies on a copy of the live database. **Rollback:** tables are unused by old code; drop them. |
| P2-03 | Capture reducer | Turn one capture into listing updates and events | new `packages/domain/src/captureReducer.ts`: `applyCapture(previous: Listing[], capture): { listings, events }` | none | Unit tests: first seen; seen again same price (no event); price changed; absent from a **partial** capture (no change); absent from a complete capture (`missed`, counter +1); absent twice (`gone`); present again after `missed` (`reappeared`); new id with same seller and fingerprint within 7 days of a `gone` (`possible_relist` linked both ways). |
| P2-04 | Capture repository | Persist a capture atomically | new `apps/server/src/repositories/captureRepository.ts` | P2-02 merged | Integration: one transaction per capture; a thrown error leaves no rows; unique `(schedule_id, captured_at)` rejects a duplicate. |
| P2-05 | Schedule sync | Create schedule rows from recipes | `apps/server/src/recipes/synchronizeRecipes.ts`, reuse `generateRecipeMarketQuery` and `hashMarketQuery`; add `economy`, `league`, `retention` rows with their current cadence from `jobs.ts` | recipes sharing a query yield one row | Integration: sync 26 recipes twice → same row count; disabling a recipe disables rows no other recipe uses. |
| P2-06 | Run requests API | Persist Run now before returning | `apps/server/src/api.ts`: `POST /api/run` inserts into `run_requests`, then `NOTIFY worksmith_wake`, then returns 202 with the id; `GET /api/collector/status` returns `collector_state`, the newest `run_requests` row, lock-held boolean, next due time. Guard with the existing `needsAdminAccess`/`isLocalAdmin`; add bearer-token acceptance for `OPERATOR_DIAGNOSTICS_TOKEN` when the app is not on loopback (Q1). | `needsAdminAccess` covers the new path | Integration: the row exists when the response returns; a second request while one is queued returns the same id; rejected without access. |
| P2-07 | Collector loop | The dedicated instance | new `apps/server/src/collector.ts`, `entrypoints/collector.ts`, `APP_MODE=collector` in `config.ts` and `runtime.ts`. Uses the existing `configuredCollectionSource` adapter, `GggRateLimitController`, `ninjaEconomy` client, `leagues.ts`, `retention.ts`. Implements the design above. | `configuredCollectionSource(...).collect` can be called without `MarketCollectionManager` | Integration with a fake adapter and a fake clock: due rows run once; failure sets `retry_at` with backoff; expired lease is recovered on start; `NOTIFY` wakes a sleeping loop within 1 s; two collectors → each due row runs exactly once and the standby takes over when the leader's connection is killed; a queued `run_requests` row is honoured after a restart with no notification. |
| P2-08 | Session reuse and re-authentication | D3 | `collector.ts`, `marketCollectionSource.ts`, `providers/poeTradeSessionManager.ts`, `repositories/tradeSessionRepository.ts` | how `onLogin` currently persists the cookie (today it only clears denials) | Unit with a fake transport: valid stored cookie → no browser launched; 401 → one login, new cookie sealed, request retried once; second 401 → `blocked_reason` set, no loop. |
| P2-09 | Evaluator on new storage | Same numbers from new tables | `catalogPublisher.ts`: extract the listing source behind an interface so `evaluateFreshRecipe` can read active `listings` for a schedule row; write `recipe_results`. Coverage flags come from the latest `captures` row. | P1 outputs unchanged for identical inputs | Integration: the same fixture data through old and new sources yields equal sale ask, cost, profit, grade and budget. |
| P2-10 | Read path switch (flag) | Web reads new results | `resourceViews.ts` `readCatalog`/`readRecipe` read `recipe_results` when `PIPELINE=collector`; `App.tsx` replaces the Refresh Prices block with a status strip and Run now using the P2-06 endpoints | default `PIPELINE=legacy` changes nothing | Browser test `run-now-updates-homepage`: with `PIPELINE=collector`, a fake adapter and a running collector, pressing Run now changes the homepage "last run" time and a recipe's cost. Existing 11 browser tests pass with `PIPELINE=legacy`. |
| P2-11 | Deployment | Three services | new `compose.server.yaml`: `postgres`, `app` (`APP_MODE=api` plus the `web` image), `collector` (`APP_MODE=collector`, volume for the browser profile). Document env in `docs/local-runtime.md`. | server image runs `entrypoints/collector.js` | `docker compose -f compose.server.yaml up` → `/health/ready` ok; collector logs `leader acquired`. |
| P2-12 | **Cutover** | Switch worker and read path together | configuration only | P2-01..P2-11 merged; database backup taken | Sequence below. |

### Cutover sequence (P2-12)

1. `pg_dump` the database. Keep the dump.
2. Apply the P2-02 migration (additive).
3. Start the collector with `PIPELINE=collector` while the old worker still runs and the app still has `PIPELINE=legacy`. Let two full cycles complete.
4. Compare: for every recipe, `recipe_results` vs the published `recipe_evaluations` (sale ask, mean cost, grade). Record differences in the Progress log. Expected differences: only those explained by newer captures.
5. In one deploy: stop the old worker (`APP_MODE=worker` process and the Home Assistant scraper add-on) and set `PIPELINE=collector` on the app.
6. **Acceptance gate:** press Run now on the homepage. Within one collection cycle the "last run" time changes and at least one recipe's `evaluatedAt` is newer than the click. If not, roll back.
7. Observe for 48 hours: no Trade authentication block, no growing `attempt` counts, homepage data age under the configured maximum.

**Rollback (any step):** set `PIPELINE=legacy` on the app, stop the collector, start the old worker and add-on. Old tables were never modified. New tables can stay.

**Stop conditions for Phase 2:** P2-01 (a) false; equality test in P2-09 fails for a reason other than data freshness; the acceptance gate in step 6 fails twice.

---

# Phase 3 — repricing, disappearance, relisting; market activity

Depends on a week of `listing_events` from Phase 2.

## What the data can say

| Observation | Classification | Counted as |
|---|---|---|
| In the latest complete capture | active | supply |
| `price_changed` event | repriced; the old price did not sell | price pressure |
| Missing from a partial capture | unknown | nothing |
| `gone` (missed in 2 consecutive complete captures at least 2 h apart), last price within 20% of the target floor at last sight, no `possible_relist`, seller still has other active listings or was seen recently | **inferred exit** | market activity |
| `gone`, last price more than 20% above the floor | uncertain exit | shown, not counted |
| All of a seller's listings for the target `gone` in one capture | uncertain exit (tab hidden or seller left) | shown, not counted |
| `possible_relist` | relisted; the earlier `gone` is reversed | nothing |
| `reappeared` within 48 h | reverses the exit | nothing |
| Active for 7+ days with no price change | stale | excluded from sale ask |

Confirmed sales come only from My Factory (`factory_events`). They are never
merged into inferred exits.

## Tasks

| ID | Task | Tests and acceptance |
|---|---|---|
| P3-01 | Pure classifier `classifyExit(listing, events, floorAtLastSeen, sellerContext)` in `packages/domain` | One unit test per table row |
| P3-02 | `target_activity` rollup per schedule row, recomputed after each capture: active count, distinct sellers, floor, inferred exits in 24 h and 72 h, uncertain exits, repriced count, median last price of inferred exits | Integration with a scripted capture sequence |
| P3-03 | API and UI: a "Market activity" block per target showing those numbers with the label "inferred from listings, not sales", and a separate "Your confirmed sales" line from My Factory | Browser test asserts the two are separate elements with distinct labels |
| P3-04 | Sale basis: when 3+ inferred exits exist in 72 h, show their median last price beside the sale ask as "recent exit price". Expected profit keeps using the sale ask until the owner approves switching (Q3). | Publisher test |
| P3-05 | Remove "Exits / day" and "Sales proxy" wording from Market trends; delete the turnover code in `tradeDashboard.ts` after R3 | Browser test |

No "profit per day" is computed from market activity. If the owner later enters
a personal craft rate, it is a separate, labelled estimate (Q4).

---

# Phase 4 — homepage, recipe page, no admin

| ID | Task | Files | Acceptance |
|---|---|---|---|
| P4-01 | Status strip polish: last run time and result, next due, collector connected, session state, block reason; Run now with progress from `run_requests` | `App.tsx`, `refreshFreshness.tsx` | Browser test with collector disconnected shows a warning, not "Updating" |
| P4-02 | Homepage table grouped by `targetSignature`: best method first, others indented. Columns: target, method, mean cost, budget p50 · p90, sale ask, expected profit, ROI, grade or block reason, market activity (after Phase 3). Default sort: expected profit. Phone: drop item class; profit and ROI under the name. Table first; nothing above it but the status strip and filters. | `App.tsx`, `CatalogTable.tsx`, `catalog.ts`, `catalogTable.css` | Browser tests at 1440 and 390 px; no horizontal page scroll |
| P4-03 | Settings moved to a collapsed section on the homepage (interval, maximum quote age, warning age, pause) | `App.tsx`, `marketAdminApi.ts` settings routes kept | Settings persist across reload |
| P4-04 | Remove the admin page and its run and audit endpoints | R3 on `AdminMarketPage`, `/admin/market`, `market_admin_runs`, `marketAdminStatus` | Route shows the not-found page; browser test `market-freshness.spec.ts` rewritten against the homepage strip, not deleted |
| P4-05 | Recipe page order: numbers, methods comparison, method steps, listings (from `listings`), price history. Caveats collapsed. | `RecipePage.tsx` | Screenshot review by the owner |
| P4-06 | Typography and colour cleanup to five sizes and the existing tokens. Decide `codex/graphite-brass-ui`: recommendation is to re-apply its tokens here, then delete the branch. | `apps/web/src/*.css` | No literal hex outside `:root` |

---

# Phase 5 — removal

Start only when Phase 2 cutover has run 7 days without rollback and Phases 3–4
are merged. Take a `pg_dump` first; it is the rollback for every drop. Each row
is one task and one PR; each begins with R3 on every symbol it removes.

| ID | Remove | Gate (must be true first) |
|---|---|---|
| P5-01 | Old refresh path: pg-boss wiring in `jobs.ts` and `process.ts`, `refreshPlanner.ts`, `refreshOrchestrator.ts`, `marketJobProcessor.ts`, `providers/poeTrade.ts`, `PIPELINE=legacy` branches, `pg-boss` dependency | No process has run with `PIPELINE=legacy` for 7 days |
| P5-02 | `MarketCollectionManager` scheduling, `entrypoints/scheduleTradeCatalog.ts`, `publishTradeCatalog.ts`, `collectTrade.ts serve`, `services/market-trade-scraper/` | Collector handles every target they handled |
| P5-03 | `services/market-collector/`, its CI job, `marketCollectionRunner` and every `=== 'go'` branch, `marketCollectorContract.test.ts` | P5-02 merged |
| P5-04 | Signals and allocator: domain `opportunitySignals.ts`, `capitalAllocation.ts`, `liquidity.ts`, `intelligence.ts`; server `intelligence.ts`, `intelligenceApi.ts`, `repositories/intelligenceRepository.ts`; web `IntelligencePanel.tsx`, `IntelligenceEvidence.tsx`, `IntelligenceSettingsFields.tsx`, `CapitalAllocator.tsx`, `CapitalFields.tsx`; intelligence fields in admin settings | My Factory does not import them (R3; `factory.ts` uses `analyzeOutcomeModel` from the outcome engine, which stays) |
| P5-05 | Belt demo: `beltOpportunity.ts`, its API routes and contracts, `calculateRecipeEconomics`. **First** move `analyzeBeltSnapshot` to `listingComparability.ts` under a neutral name and replace `beltDemoFixture` in the 9 active test files with a neutral fixture of the same shape. | The 9 test files still pass with the renamed fixture before any deletion |
| P5-06 | Legacy research API and `start:market` | Web no longer calls `/api/market*` (R3 on `apiClient.ts`) |
| P5-07 | Tables, one migration per group, each after its code is gone: `refresh_cycles`, `catalog_state`, `jobs`, `market_queries`, `raw_snapshots`, `aggregated_observations`, schema `pgboss`; `market_targets`, `market_collection_*`, `market_research_snapshots`, `market_worker_health`; `market_admin_runs`, `market_admin_audit`; `belt_price_updates`, `craft_probability_results`, `provider_circuits`; `craft_signal_*`, `craft_allocation_plans` | `grep` shows no reader; row counts recorded; dump taken |
| P5-08 | Query review with `EXPLAIN (ANALYZE, BUFFERS)` on live data for: homepage (target: one query on `recipe_results` joined to `target_activity`), recipe page, collector lease, capture upsert. Cache parsed recipe documents by `content_hash`. Add or drop indexes only with a plan that justifies it. | P5-07 merged |
| P5-09 | Replace the free-form `methodCost` object with the zod schema used by `recipe_results`; split `postgresRepositories.ts` by table group | P5-07 merged |

Acceptance for the phase: `\dt` lists 25 or fewer tables; R1 both blocks pass;
the homepage request issues 3 or fewer SQL statements on the test database.

---

# Phase 6 — catalog growth

| ID | Task | Acceptance |
|---|---|---|
| P6-01 | Recipe audit: `docs/recipe-audit.md`, one row per recipe with thresholds, method, probability, source, verdict. Check first: `life >= 130` on Stygian Vise (two recipes) and on shields at item level 60 and 70; bench-craft costs entered as `chaos-orb × 3/4`; `enkindle-effect` p = 0.035. No value changes without a source link; unconfirmed recipes become `unverified`. | 25+ rows; every changed value has a link |
| P6-02 | Import mod stat ranges for the active patch through the existing game-data importer; validator rejects thresholds outside the range | Validator fails on a test recipe with an impossible threshold |
| P6-03 | Second method for each Chaos-only cluster target | Homepage shows grouped methods |
| P6-04 | Default hit-or-miss outcome model per recipe so multi-stage budgets work; remove the P1-05 single-stage limit | Flask recipes show p50 and p90 |
| P6-05 | Discovery targets per item class without a recipe; rank mod combinations by inferred exits and price; owner picks which become recipes | First discovery report reviewed |

---

## Open questions (none block Phase 1)

| # | Question | Default used by the plan |
|---|---|---|
| Q1 | Is the app instance reached only from the server itself, or from other devices? | Other devices on a private network; writes need the bearer token |
| Q2 | Collection cadence | Recipe outputs hourly, bases every 2 h, economy every 30 min, 5 price slices at most |
| Q3 | After Phase 3, should expected profit use the recent exit price instead of the sale ask? | No; show both |
| Q4 | Do you want a personal profit-per-day estimate from your own craft rate? | Not built |

## Verification limits

- Not run against live Trade or poe.ninja. The 100-result cap, id stability and rate-limit behavior are checked by P2-01 and P2-07 before anything depends on them.
- The recipe concerns in P6-01 are flags from review, not confirmed errors.
- The Craft of Exile calculator models the generic 8–12 passive Large Cluster Jewel mod pool. Both P1-07 methods must use Trade queries for exactly 8 passives.

## Progress log

| Date | Task | PR | Notes |
|---|---|---|---|
| 2026-11-09 | P1-01 | [#44](https://github.com/MaksimSurmach/POE_WA/pull/44) | Both R1 blocks passed on `b0d3c1303c434d6e3ed996ecc99299b308008f39`: 818 Vitest unit tests, 1 Node runtime test, 169 integration tests, 8 backend E2E tests, 10 browser tests, 28 recipes. PostgreSQL 17.11 was isolated; no live Trade. |
| 2026-11-09 | P1-02 | [#45](https://github.com/MaksimSurmach/POE_WA/pull/45) | Both R1 blocks and CI passed. Removed 8 unit cases and 1 integration case covering only the deleted code. |
| 2026-11-09 | P1-03 | [#46](https://github.com/MaksimSurmach/POE_WA/pull/46) | R1 first block and CI passed. Regression confirms the guarded ask drives the profit calculation. |
| 2026-11-09 | P1-04 | [#48](https://github.com/MaksimSurmach/POE_WA/pull/48) | Both R1 blocks and CI passed. Single-currency sorted coverage was tested with a fixture. |
| 2026-11-10 | P1-05 | [#49](https://github.com/MaksimSurmach/POE_WA/pull/49) | Both R1 blocks and CI passed. The budget reuses the domain Decimal implementation and existing risk helper. |
| 2026-11-10 | P1-06 | [#47](https://github.com/MaksimSurmach/POE_WA/pull/47) | R1 first block and CI passed. Reordered fossils count as the same method, and three unchanged drafts left the active catalog. |
| 2026-11-10 | P1-07 | [#50](https://github.com/MaksimSurmach/POE_WA/pull/50) | Both R1 blocks and CI passed. Mapped query test uses `recipeCatalog.test.ts`. |
| 2026-11-10 | P1-08 | [#51](https://github.com/MaksimSurmach/POE_WA/pull/51) | R1 first block and CI passed. The existing detail refresh also updates the comparison when needed, so expired values do not keep ranking. |
| 2026-11-10 | P1-09 | [Browser proof PR](https://github.com/MaksimSurmach/POE_WA/pulls?q=is%3Apr+head%3Arefocus%2Fp1-09-browser-proof) | Both R1 blocks and the separate priced browser scenario passed locally. CI runs the default suite and the priced scenario separately. |
| 2026-11-10 | P2-01 | [Evidence PR](https://github.com/MaksimSurmach/POE_WA/pulls?q=is%3Apr+head%3Arefocus%2Fp2-01-listing-evidence) | Passed for observed repricing. See evidence below. |
| 2026-11-10 | P2-02 | [#54](https://github.com/MaksimSurmach/POE_WA/pull/54) | Both R1 blocks, CI, and migration checks passed. PostgreSQL 17 applied the migration locally. All 25 generated DDL statements also passed on a temporary copy of live PostgreSQL 16, preserving legacy row counts. |
| 2026-11-10 | P2-03 | [#55](https://github.com/MaksimSurmach/POE_WA/pull/55) | R1 first block and CI passed. The 23 reducer cases include an earlier replacement appearing before the old listing becomes gone. |
| 2026-11-10 | P2-04 | [#56](https://github.com/MaksimSurmach/POE_WA/pull/56) | Both R1 blocks and CI passed. Seven PostgreSQL cases cover atomic writes, lock and socket failure, bounded history reads, and price precision. |
| 2026-11-10 | P2-05 | [#57](https://github.com/MaksimSurmach/POE_WA/pull/57) | Schedule reconciliation and CI passed: 26 active recipes resolve to 43 Trade keys plus three other schedules. Unchanged schedules keep their lease, retry, and due state. |
| 2026-11-10 | P2-06 | [#58](https://github.com/MaksimSurmach/POE_WA/pull/58) | Both R1 blocks and CI passed. Requests and wake notifications commit together, and status and trigger routes enforce the operator guard. |
| 2026-11-10 | P2-07 | [#59](https://github.com/MaksimSurmach/POE_WA/pull/59) | Both R1 blocks and CI passed: 902 unit tests, 198 integration tests, 8 backend E2E tests, and 11 browser tests. Both collector entrypoints acquired the lock and shut down cleanly. Trade was faked; mixed-currency ranges above the cap remain partial until verified. |

P2-01 used read-only aggregates over all 759 observed snapshots from November 5–7 UTC. Each snapshot matched the capture time of a noncached `trade-compatible` run. The sample had 552 complete captures (126 empty), 207 partial captures, 49 targets, and 14,952 listing rows.

Matching on target and query digest gave 1,675 listing histories, of which 1,284 spanned at least two capture times. Nine distinct Trade result IDs across six query cohorts changed their original ask. Seven adjacent changes in the same currency retained the same Trade result ID, seller, stash, and core item fields including base, item level, properties, sockets, and mods. Three pairs had complete captures on both sides: 180 → 160 divine, 88 → 40 chaos, and 210 → 200 divine. Across the nine original-ask transitions, the only changed raw item fields were `note` and `extended`.

All 14,952 rows had an external ID matching the raw Trade result ID, seller, indexed time, original price and currency, and nonempty normalized mods. Raw explicit, implicit, enchant, and utility mod arrays were present in 14,569, 8,039, 6,335, and 2,004 rows respectively. No row had `modsComplete=true`. The stored raw item ID matched the Trade result ID in every row, so physical item identity cannot be checked independently. The observed repricings support using the Trade result ID across price edits. Stability across relisting or outside these captures remains unverified.
