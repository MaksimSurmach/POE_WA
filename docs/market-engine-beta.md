# Working market engine beta

The beta connects the existing PostgreSQL collection manager to a separately configured Trade-compatible website transport. It does not establish official GGG authorization for the website's internal search/fetch endpoints. Automatic requests remain disabled by default.

## Run

Use Node 22.13 or later within Node 22, pnpm 11, and PostgreSQL 17. The repository's previous 22.12 pin cannot run pnpm 11.8.

```sh
pnpm install --frozen-lockfile
# Create .env.development from .env.development.example only if it does not exist.
test -f .env.development || cp .env.development.example .env.development
pnpm db:up
pnpm db:migrate
pnpm build
pnpm market:import-catalog "$PWD/catalog/market-beta-3.29.json" --dry-run
pnpm market:import-catalog "$PWD/catalog/market-beta-3.29.json"
pnpm start:market
```

In another terminal:

```sh
pnpm --filter @poe-worksmith/web dev --host 127.0.0.1
```

Open [the workbench](http://127.0.0.1:5173/). An existing PostgreSQL 17 instance also works: set `DATABASE_URL` to a dedicated database and apply migrations without running `db:up`. Do not use `db:reset` on data you want to retain.

The checked-in catalog has five scoped research targets: Flicker and Winter Orb belts, RF Fire Trap and Spectre helmets, and a Lacerate shield. The three helmet/shield projections retain MAX-1288 decisions, recipe steps, acquisition conditions, limits and input file hashes. The two belts retain their research status. None has invented current prices or a claimed profitable recipe. Existing starter profiles, snapshots and target versions remain intact.

For a complete synthetic calculation:

```sh
pnpm market:seed-belt-demo
```

Refresh the screen and choose **DEMO · синтетические данные** above the ranking. This demo is synthetic and uses the existing manual importer. The PostgreSQL integration test exercises all five structured targets through the actual search/fetch transport with injected endpoint-format fixtures, not live Trade responses.

## Trade access

Inject these variables into the server's secure local environment, then restart it:

```dotenv
MARKET_COLLECTION_SOURCE=trade-compatible
POE_TRADE_ACCESS=owner_permitted
POE_TRADE_BASE_URL=https://www.pathofexile.com
POE_TRADE_USER_AGENT="POEWorksmith/0.1 (contact: your-real-contact)"
POE_TRADE_REQUEST_TIMEOUT_MS=10000
```

`POE_TRADE_SESSION_ID` is optional session authentication. Load its value from a secure environment. Do not put the value in Git, command arguments, shell history, frontend state or screenshots. Account passwords are not accepted by the provider. Selecting `owner_permitted` records the owner's access configuration; it does not represent approval from GGG. No CAPTCHA handling, proxies or protection evasion are implemented.

The catalog import prints saved target UUIDs. Test one target with:

```sh
pnpm market:test-connection TARGET_UUID
```

This uses the same PostgreSQL rate gate and makes at most one search and one single-listing fetch within a 30-second budget. It does not create a schedule or market snapshot. Output contains only `CONNECTED`, `AUTH_REQUIRED`, `ACCESS_DENIED`, `RATE_LIMITED` or `UNAVAILABLE`, the target UUID and whether a session was configured. It never prints the session.

After connectivity is confirmed, select a target in **Сбор**, run once, then enable its schedule if desired. Each profile has an independent enable switch, pause/resume, interval and next-run time. At most four runs execute per process; detail batches are sequential and limited to ten IDs, 100 batches and 1,000 fetched listings per run. PostgreSQL coordinates request budgets and durable run state across processes. Pause/disable/cancel are checked after every permit and before every request. 401, 403, redirects and challenges stop further access; a saved denial also blocks a restarted manager. Do not delete denial records to retry a denied source. Investigate access first.

Response headers and `Retry-After` govern cooldown. HTTP 429/5xx responses get at most two retries. Request timeouts fail the run rather than creating an unlimited retry queue. Complete, partial, empty, failed, cached and inexact results remain distinct. Search JSON, query ID, returned IDs, total, raw listing observations and normalization version are retained. Reflected session secrets and credential keys are redacted before persistence.

## Profiles, matching and economics

- Import versioned JSON through **Импорт каталога JSON** or `market:import-catalog`; CSV is not required. `schemaVersion=1`, `profiles[]`, and each profile's `catalog.key`, `catalog.revision`, `progression`, `verification` and `unknowns` are required for bulk imports. All profiles validate before writes. Same revision/content is idempotent; a conflicting same revision is rejected. New revisions preserve old profiles and snapshots. Ranking uses the newest catalog revision within the same game, realm, league and patch.
- A profile's `tradeSearch` defines currency, availability/merchant state, rarity, strict/broad scope and AND/count groups of exact stat IDs. One base type is searched per profile. Unsupported IDs and ambiguous multiple-base searches fail before HTTP. Known IDs and text mappings are versioned in `tradeStatMappings.ts`; they come from [Awakened PoE Trade revision 318820895742](https://github.com/SnosMe/awakened-poe-trade/tree/3188208957422b21b69b12083a03edf3d1bac187). The query preview includes reproducible JSON, hash, generator/mapping version and a compressed Trade link. Broad searches relax numeric thresholds by 20%; the matcher still tests the original strict requirements. Tier constraints are verified locally from listing metadata.
- Exact English modifier text and metadata establish numerical rolls, origin and tiers. Missing, malformed, ambiguous or unsupported evidence is `PARTIAL`, never a guessed match. Hybrid/conditional elemental resistance lines are currently unknown; simple fire/cold/lightning resistance totals are supported. Raw observations remain available. Independent sellers are deduplicated case-insensitively.
- The existing `beltCraftMethod` field also serves structured helmet/shield profiles for compatibility. It accepts a documented probability or explicitly entered expected attempts, material quantity per attempt, dated base/material prices, optional finishing costs, an optional entered attempts range and a base replacement/recovery assumption. These are scenarios, not fabricated exact crafting probabilities. For consumable bases, a replacement policy is mandatory. No recovery credit is taken unless a recovery price is supplied. The detailed breakdown retains expected base replacements and net replacement cost.
- The existing price-update form and API refresh base, material, finishing and configured recovery prices without replacing target definitions or historical snapshots. Public economy references use exact stored snapshot and line IDs; aggregate base prices do not prove item level, influences or a rare item's price.
- Chaos/divine conversion requires an explicitly selected, same-league Currency Exchange observation within 24 hours of both calculation and market observation. Original asking price/currency and exchange provenance remain attached. No implicit exchange rate is used. `exchangeSnapshotId` can be selected on `tradeSearch` for listings and on a price reference for crafting costs.
- Calculation readiness, positive/non-positive spread, freshness and confidence are separate. A negative spread remains a valid calculated result. Sparse (<5 independent confirmed sellers), stale or missing samples do not produce a recommendation. Costs and asking prices are gross indications, not guaranteed sale proceeds; gold fees remain raw evidence and are not silently converted to chaos.
- Ranking is explainable: available calculations first, then evidence confidence, ROI, independent sellers and, for ties, a smaller observed influx of listings. It does not compare raw chaos and divine spreads as if they were the same currency. Supply changes describe compatible query scopes, not completed sales. Partial/truncated/cached observations cannot establish disappearance.

## Verified on November 1, 2026

Local checks passed: 333 unit tests, 71 PostgreSQL integration tests, 7 provider contract tests, 7 backend E2E tests, typecheck, lint, build and migration validation. Contract/backend E2E tests overlap the broader suites; these counts are not a sum of unique tests. CI results are reported on the PR.

Local environment: Node 22.13.0, pnpm 11.8.0, PostgreSQL 17.11, a dedicated `poe_worksmith_test` and `poe_worksmith_beta`. No production data was reset.

- Five curated structured targets exercised through catalog import → query → POST search → GET fetch → normalization → MATCH/PARTIAL/REJECT → immutable PostgreSQL snapshot → costing → ranking/API.
- Three independent synthetic observations per target: 15 snapshots, 30 injected HTTP-format requests. New, missing, reappeared, increased/decreased prices and independent sellers verified. Includes negative profit, restart, repeat import and paused collection.
- Currency conversion tests cover both directions, wrong league/category, stale/missing exchange evidence and retention of original raw listing fields. Provider tests cover missing/malformed mods, count groups, tiers, cache capture time, 401/403/429/503, redirect/challenge, schema changes, timeout and secret redaction. Existing suites cover partial/empty samples, durable recovery and cross-process rate limits.
- Live public poe.ninja collection succeeded for Allflame: Currency 99 rows, Essence 68, Fossil 24, Resonator 4, BaseType 8,956. First receipts: 2026-11-01 22:22:17 UTC. These are real economy observations, not rare item comparables. The source does not provide a trustworthy upstream timestamp.
- The owner supplied a disposable test account through Vault. PoE's normal login page presented a Cloudflare challenge before credentials were submitted. No protection bypass or subsequent automated PoE request was attempted. Live Trade search/fetch remains unverified; fresh live rare observations: **0**. Automatic collection stays off.
- Browser smoke: catalog dry-run, write and duplicate import; strict/broad query preview; DEMO cost 18 chaos, asking price 40 chaos, spread 22 chaos; desktop and 390×844 mobile. QA also found and fixed selection drifting between ranking and collection, and duplicate React keys for repeated source URLs. No relevant browser warnings/errors after the fixes; mobile page width remains 390px and the wide table scrolls inside its container. Automated native file selection was blocked by the Chrome extension's file URL permission; the JSON editor import was verified instead.
- A dedicated beta database backup restored successfully with seven targets, one DEMO rare snapshot and five live economy snapshots. Manager/process restart tests preserve observations.

This is a working implementation with fixture-backed rare-market verification and live economy verification. It is **not live-market-ready** until permissioned Trade connectivity and repeatable real rare-item observations pass. MAX-1288 financial acceptance and live-game build equivalence are not implied by importing its scoped research results.
