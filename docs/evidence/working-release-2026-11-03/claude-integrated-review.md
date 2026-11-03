# Review: integrated release branch vs `origin/codex/market-admin-runtime`

**Verdict: I found no reproducible P1/P2 blockers in the code I inspected.**

The review was cut off by the turn limit before I finished, so it is not complete. The parts I did not reach are listed under residual unknowns. I ran no tests and changed no files.

## What I checked

**`startingMods` and fracture constraints**

- The schema in `packages/domain/src/canonical/craftMethod.ts:30-44` now accepts `kind`, `minimumValue` and `maximumValue`, and rejects a minimum above the maximum.
- The sort key in `packages/domain/src/canonical/normalization.ts:54-57` includes the new fields.
- `recipeTargetSignature` ignores `startingMods`, so the two existing cluster recipes keep their signatures.
- `apps/server/src/recipeMarket.ts:136-145` passes the kind and min/max through. The translator uses them because no mapping payload sets its own minimum or maximum.
- I cross-checked all 15 recipes:
  - Every base, mod and material resolves to a mapping.
  - Every target and starting stat ID has an entry in `tradeStatMappings`, so listings with those mods can be recognised.
  - Each condition's kind matches the origin of its stat ID.
  - All four fractured recipes set `fractured: true` on both `startingBase` and `base`.
- The normalizer matches stats per origin (`providers/tradeCompatible.ts:213-259`). A plain suppression roll cannot satisfy a fractured-suppression filter.

**Active same-patch Trade mappings**

- All three lookups now require `gdv.status='active'` (`tradeMappings.ts:148`, `:222`). Import already targets only the active version (`:241`).
- Activation archives the previous active version in one transaction (`gameData.ts:118-131`).
- The two manifests have no conflicting canonical IDs.

**Chaos Orb fees**

- `chaos-orb` is never sent as an exchange query (`recipeMarket.ts:65-71`).
- In `catalogPublisher.ts:532-550` it is priced at exactly 1 chaos, either directly or through `convertMarketQuote`, which returns same-currency amounts unchanged. Handbook targets always use chaos as the output currency.
- The evidence record fits the `priceSources` contract (`packages/contracts/src/index.ts:191-201`).
- Expected cost stays `null` unless verification evidence exists, so no expected value is invented for the unverified recipes.

**Current target comparability**

- `analyzeBeltSnapshot` checks fracture, exact influences, values and tiers. Missing evidence produces `PARTIAL`, never `MATCH`.
- Partial collections that are not a complete sorted page aggregate to an empty result (`catalogPublisher.ts:757-764`).

**Cancellation and recovery**

- `failCycle` now locks jobs before the cycle (`marketAdmin.ts:367-374`), the same order as `commitSuccess` (`postgresRepositories.ts:847-883`). `publish` does not lock jobs, so I see no lock-order cycle.
- Queue expiry claims the run atomically (`marketAdmin.ts:393-399`). A run already claimed by a worker is skipped.
- Failure codes are ranked operator cancellation, then worker interruption, then provider error (`refreshCancellation.ts:24-32`).
- The retry-drain loop is bounded: 45 minutes between batches, a check on `cycle.status`, and cancellation through `delay(..., {signal})`.
- A failed refresh never replaces the published catalog. Snapshots and observations are not deleted.

**Packaging**

- `compose.yaml` build targets match the Dockerfile stages (`web`, `server`).
- nginx does not add `X-Forwarded-*` headers, and requests arrive from the container's IP, not loopback. `isLocalAdmin` (`adminAccess.ts:4-28`) therefore still rejects admin access and refresh writes through Docker, as the README states.

## Residual unknowns and limits (not blockers)

1. **One bad recipe fails the whole refresh.** `refreshPlanner.ts:252-262` does not catch query-generation errors per recipe. A single unmapped recipe fails the entire cycle with `INTERNAL_ERROR`, including the two cluster recipes.
   - This behaviour is not new, but exposure grew from 2 recipes to 15.
   - Two concrete ways to hit it:
     - A worker refreshes between `game-data:activate` and the two `trade-mappings:import` commands.
     - An upgraded database gets `recipes:sync` without importing `recipe-catalog.json`.
   - Either way the run fails and the last catalog is kept, so nothing is lost. Following the README order avoids it.
2. **Not inspected:**
   - Whether `marketTradeQuery.ts` sends an influence filter to Trade. If it doesn't, the elder/shaper recipes only filter influence after collection, inside the 1000-ID window, which can leave fewer matches.
   - Whether `MarketJobProcessor.runAvailable` limits claims to the current cycle.
   - Whether `recipes:sync` checks bases against the active game data.
   - The Dockerfile web build stage.
   - That `vite preview` reuses `server.proxy`. I could not check current Vite docs, so this rests only on the smoke evidence.
3. **45-minute retry budget:** it is checked only between batches. A batch already running can use up the remaining time, and pg-boss's one-hour abort is the final limit. This is documented and not reproduced as a failure.
4. **`chaos-orb` handling:** its special case is a hard-coded string in two places, and the `chaos-orb → chaos` resource mapping in the manifest is never used. Harmless today.
5. **What this review cannot show:** live Trade access, real listing shapes for fractured or influenced items, current prices, and craft success rates. The new recipes stay unverified, as their docs say.

This is independent evidence, not a GitHub approval.
