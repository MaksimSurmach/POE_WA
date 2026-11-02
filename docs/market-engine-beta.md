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

Refresh the screen, select the **Demo** league and **DEMO** in the ranking data selector. This demo is synthetic and uses the existing manual importer. The PostgreSQL integration test exercises all five structured targets through the actual search/fetch transport with injected endpoint-format fixtures, not live Trade responses.

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

The catalog import prints saved target UUIDs. Revision 3 adds descriptions and configured Craft of Exile variants while keeping earlier revisions and snapshots. Test one target with:

```sh
pnpm market:test-connection TARGET_UUID
```

This uses the same PostgreSQL rate gate and makes at most one search and one single-listing fetch within a 90-second budget. It does not create a schedule or market snapshot. Output contains only `CONNECTED`, `AUTH_REQUIRED`, `ACCESS_DENIED`, `RATE_LIMITED` or `UNAVAILABLE`, the target UUID and whether a session was configured. It never prints the session.

After connectivity is confirmed, select a target in **Сбор**, run once, then enable its schedule if desired. Each profile has an independent enable switch, pause/resume, interval and next-run time. At most four runs execute per process; detail batches are sequential and limited to ten IDs, 100 batches and 1,000 fetched listings per run. PostgreSQL coordinates request budgets and durable run state across processes. Pause/disable/cancel are checked after every permit and before every request. 401, 403, redirects and challenges stop further access; a saved denial also blocks a restarted manager. Do not delete denial records to retry a denied source. Investigate access first.

Response headers and `Retry-After` govern cooldown. HTTP 429/5xx responses get at most two retries. Request timeouts fail the run rather than creating an unlimited retry queue. Complete, partial, empty, failed, cached and inexact results remain distinct. Search JSON, query ID, returned IDs, total, raw listing observations and normalization version are retained. Reflected session secrets and credential keys are redacted before persistence.

## Profiles, matching and economics

- Import versioned JSON through **Импорт каталога JSON** or `market:import-catalog`; CSV is not required. `schemaVersion=1`, `profiles[]`, and each profile's `catalog.key`, `catalog.revision`, `progression`, `verification` and `unknowns` are required for bulk imports. All profiles validate before writes. Same revision/content is idempotent; a conflicting same revision is rejected. New revisions preserve old profiles and snapshots. Ranking uses the newest catalog revision within the same game, realm, league and patch.
- A profile's `tradeSearch` defines currency, availability/merchant state, rarity, strict/broad scope and AND/count groups of exact stat IDs. One base type is searched per profile. Unsupported IDs and ambiguous multiple-base searches fail before HTTP. Known IDs and text mappings are versioned in `tradeStatMappings.ts`; they come from [Awakened PoE Trade revision 318820895742](https://github.com/SnosMe/awakened-poe-trade/tree/3188208957422b21b69b12083a03edf3d1bac187). The query preview includes reproducible JSON, hash, generator/mapping version and a compressed Trade link. Broad searches relax numeric thresholds by 20%; the matcher still tests the original strict requirements. Tier constraints are verified locally from listing metadata.
- Both the older string modifiers and the current object modifiers are supported. Object hashes and exact English text establish numerical rolls, origin and tiers; full-item omitted false flags are normalized. Bench tier 0 is unknown affix-tier evidence, not tier 1. Compressed query IDs may exceed 256 characters. Normalization is recorded as `trade-compatible-v2`. Missing, malformed, ambiguous or unsupported evidence is `PARTIAL`, never a guessed match. Hybrid/conditional elemental resistance lines are currently unknown; simple fire/cold/lightning resistance totals are supported. Raw observations remain available. Independent sellers are deduplicated case-insensitively.
- The existing `beltCraftMethod` field also serves structured helmet/shield profiles for compatibility. It accepts a documented probability or explicitly entered expected attempts, material quantity per attempt, dated base/material prices, optional finishing costs, an optional entered attempts range and a base replacement/recovery assumption. These are scenarios, not fabricated exact crafting probabilities. For consumable bases, a replacement policy is mandatory. No recovery credit is taken unless a recovery price is supplied. The detailed breakdown retains expected base replacements and net replacement cost.
- The existing price-update form and API refresh base, material, finishing and configured recovery prices without replacing target definitions or historical snapshots. Public economy references use exact stored snapshot and line IDs; aggregate base prices do not prove item level, influences or a rare item's price.
- Chaos/divine conversion requires an explicitly selected, same-league Currency Exchange observation within 24 hours of both calculation and market observation. Original asking price/currency and exchange provenance remain attached. No implicit exchange rate is used. `exchangeSnapshotId` can be selected on `tradeSearch` for listings and on a price reference for crafting costs.
- Calculation readiness, positive/non-positive spread, freshness and confidence are separate. A negative spread remains a valid calculated result. Sparse (<5 independent confirmed sellers), stale or missing samples do not produce a recommendation. Costs and asking prices are gross indications, not guaranteed sale proceeds; gold fees remain raw evidence and are not silently converted to chaos.
- Without a craft calculation, candidates with more confirmed independent sellers appear first. Ranking is explainable: available calculations first, then evidence confidence, ROI, independent sellers and, for ties, a smaller observed influx of listings. It does not compare raw chaos and divine spreads as if they were the same currency. Supply changes describe compatible query scopes, not completed sales. Partial/truncated/cached observations cannot establish disappearance.

## Verified on November 2, 2026 (Europe/Warsaw)

Environment: Node 22.13.0, pnpm 11.8.0, PostgreSQL 17.11, dedicated `poe_worksmith_test` and `poe_worksmith_beta`. No production reset or merge.

- **Trade CONNECTED:** real website search/fetch returned HTTP 200 without a session credential. Owner login and a normally opened Trade page were checked; no account password or cookie was needed by the successful provider. The local database contains **9 real rare-market snapshots for five profiles**. Flicker, Winter Orb and RF each have two independent uncached observations. Spectre has two zero-result observations; Lacerate has one. [Receipts](evidence/market-beta-live-2026-11-02.json) retain target/query digests, capture times, run and snapshot IDs, counts and coverage. Raw observations remain immutable in the local review database.
- Latest confirmed samples: Winter Orb **29 sellers, median 222 chaos** (30 fetched); Flicker **7 sellers, median 200 chaos**; RF Fire Trap **6 sellers, median 345 chaos**. These are asking prices. Matching, raw observations, seller deduplication, history and supply comparisons run through the existing manager and API.
- **Economy:** five earlier real Allflame snapshots remain: Currency 99 lines, Essence 68, Fossil 24, Resonator 4, BaseType 8,956. A temporary league-discovery cooldown was respected; discovery subsequently returned Allflame, Hardcore Allflame, Standard and Hardcore. These sources do not establish a profitable rare craft or a trustworthy upstream price-update time.
- **UI:** one primary list with right-side exact Trade links and expandable descriptions, requirements, build sources, craft variants and configured Craft of Exile links. A belt link was opened and verified as Stygian Vise ilvl 85 with the recorded four requirements. League selection scopes ranking, snapshot history and economy selection; current source league is the default. If discovery fails, a labelled fallback uses the latest actual observation, excluding demos. The user can select another league; an unsupported new league is not silently populated with old profiles.
- **Local checks:** 336 unit tests (68 domain, 10 contracts, 233 server, 25 web), 71 PostgreSQL integration, 7 provider contract and 7 backend E2E tests passed, along with typecheck, lint and build. Contract and backend E2E counts overlap broader suites. The timeout test now controls the deadline signal and checks its requested duration instead of depending on wall-clock scheduling. The whole-repository formatting check still reports pre-existing files; changed implementation files are formatted.
- **Visual validation:** desktop 1440×1000 and mobile 390×844 list/expansion captures were inspected with no page overflow. The independent visual reviewer accepted the scoped interface with disposition **ship** after both requested fixes: a denser mobile first viewport and removal of heading eyebrows. Final captures were checked at 1440×1000 and 390×844; the complete first mobile item and its Trade action fit (action bottom 772.5px), including the fallback notice. No console errors/warnings were reported after reload. This does not establish live economics or independent assistive-technology validation.

The rare-market connection and persistence are now verified live, rather than fixture-only. The five curated recipes remain research content: complete current craft inputs and expected attempts are missing, so their live craft cost, spread and ROI remain unavailable. The calculator pipeline is verified with clearly labelled synthetic scenarios; importing recipes does not establish MAX-1288 financial acceptance or complete character/build equivalence. Automatic schedules remain disabled; run-once is available and uses durable response-header budgets.
