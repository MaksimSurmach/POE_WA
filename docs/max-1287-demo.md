# MAX-1287: belt opportunity demo

## What is real

`pnpm market:seed-library` adds three source-linked rare Stygian Vise research profiles alongside the existing catalog. The guides describe Lacerate Gladiator, Spectre Summoner, and Flicker Strike Slayer. The first two do not give quantitative thresholds; the third includes life, total elemental resistances and attack elemental damage, but does not establish item level, influence or quality. Their executable rules and craft probabilities therefore remain unverified. These are research leads, not proven opportunities.

Manual rare-listing imports preserve raw payloads. Analysis v1 records MATCH/PARTIAL/REJECT and reasons. Unknown properties are not a match. Listings marked delisted are not sales. The opportunity endpoint considers only confirmed listings from one snapshot, deduplicates sellers, requires at least five and a snapshot no older than 24 hours. It uses the cheapest confirmed independent seller as a conservative **asking price**, not a sale price. Samples are manually selected and may be biased.

## Reproducible synthetic demo

With the configured PostgreSQL database and app (see README):

```sh
pnpm market:seed-library
pnpm market:seed-belt-demo
```

The second command creates an explicitly marked DEMO target and five synthetic listings. It is idempotent within a UTC day and never deletes prior records. Start the app, select **DEMO · синтетические данные** in the belt panel and open the result. The synthetic method assumes independent 25% success, repeats on one reusable base, uses one fixture orb per attempt and has no recovery, fees or finishing cost. The synthetic input prices are 10 chaos for the base, 2 chaos per orb and 40–60 chaos for five offers. Existing recipe economics produces 4 expected attempts, 18 chaos expected cost, 40 chaos conservative asking price and 22 chaos indicative spread. None of these values are real market data or a profit guarantee. Open the evidence details and snapshot to inspect the assumptions and row-level matching.

The target form accepts `beltRules` and `beltCraftMethod` as JSON. The schema is in `packages/contracts/src/market.ts`; the complete fixture is in `apps/server/src/beltDemoFixture.ts`. Target rules, craft method and price assumptions are immutable parts of the saved profile. A changed assumption creates a new versioned profile, not a reinterpretation of old observations. Existing snapshot summaries remain user-selected, while `belt-comparability-v1` is a separately requested interpretation.

A method must describe a source, steps, full-rule confirmation, probability or expected attempts, and explicitly use the same reusable base for all failed attempts. Its manual base and material estimates must carry league, patch, currency, timestamp, provenance URL, notes, and observed/demo designation. Alternatively, material prices can reference a saved economy snapshot and exact line. League, material identity, time and currency are checked; economy data lacks a patch field, so the profile must declare the matching patch. BaseType aggregates cannot establish item level or influence and are rejected as base prices. No foreign-exchange conversion is performed. Listing and input timestamps must be within 24 hours, and demo and observed inputs cannot mix. The result remains `INSUFFICIENT_DATA` when a gate fails. Manual confirmations and prices are user assertions and require independent review.

## Verified checks

- Workspace unit suite: domain 68, contracts 10, server 161, web 23; typecheck, lint and production build passed under local Node 24 (the supported CI runtime is Node 22).
- Isolated PostgreSQL 17: all 38 integration tests passed. Seeding the demo twice returned the same target and snapshot.
- Browser smoke with the bundled Playwright runtime: DEMO ranking, expected values, detail disclosure and MATCH rows passed; repeated successfully after restarting the API. No page errors observed.
- Comparison tests cover mod mismatch, missing tier, duplicate seller, currencies and stale/sparse samples. Opportunity tests cover missing or mismatched prices, invalid probability, incomplete rules and isolation of DEMO versus observed records.

## External blockers and remaining work

- The public Trade page returned HTTP 403 on 2026-10-29. There is no permissioned real rare listing in this environment; no live import-to-analysis acceptance or real actionable target is claimed. Supply an authorized observation with original item properties and seller, or approved public-stash access. Do not scrape undocumented endpoints or use cookies.
- The three guide-backed profiles need independently verified, complete executable requirements and supported, reproducible craft methods with probability evidence. In particular, total elemental resistance is not yet represented as a composite rule. No guide-backed target currently has a fully validated cost breakdown.
- Economy prices do not provide item-level/influence-specific base quotes; obtain a dated authorized manual base quote. Validate probability and any recovery/finishing assumptions before making a real decision.
- This remains partial MAX-1287 until at least one real authorized rare observation flows through the UI and the target, method and costs are verified. Two real actionable targets remain the commercial goal. CI for the current PR head must pass separately.
