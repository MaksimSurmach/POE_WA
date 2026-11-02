# Independent Claude Code review

Final code commit: `b772c0257f4897022d238772525f926ec14c52b3`.
Reviewer used Claude Code in read-only plan mode with Read/Grep/Glob and
read-only Git commands. No edits, tests, processes or network were delegated.
Review receipts are in `claude-review-receipts.json`.

Earlier findings were repaired and re-reviewed: fractional ages; cancelled and
incomplete collection pricing; capped sorted price pages; stock-qualified bulk
pricing; expired detail snapshots; durable material-preparation failures;
refresh progress/navigation and duplicate triggers; current normal-item response
normalization; raw-data revalidation; immutable capture time versus successful
HTTP revalidation. The final verdict below is copied from the reviewer output.

## Final reviewer output

# Final verification of the revalidation fix (`626920a..b772c02`)

No blocking findings: the prior P2 is resolved and I found no new P1 or P2 in this delta. This was read-only; I didn't edit anything or run tests, processes or network calls.

## Your four conditions

- **Cache hits never count as a recheck.**
  - `catalogPublisher.ts:181-191` only counts succeeded attempts whose `cacheStatus` is `fetched` or `revalidated`.
  - `collectRecipeMaterialPrices` (`marketEconomy.ts:105-120`) records the client's real `cacheStatus`.
  - If only a hit receipt exists, `verifiedAt` stays at the original `capturedAt`, and a 31-minute-old payload is still rejected.
- **Receipts attach to the right snapshot.**
  - `repository.save` uses `on conflict (league, category, payload_hash, captured_at) … returning payload` and returns the existing row's id.
  - So a revalidated or identical-hash response points the attempt at the same snapshot that `latest(league, category)` returns.
  - The filter also checks attempt league and category against the snapshot.
- **No cross-league mixing.**
  - Material snapshots still require `snapshot.league === league` (`catalogPublisher.ts:216`).
  - Currency conversion still requires `exchange.league === target.league` (`marketCurrency.ts:32`).
- **No future-time acceptance.**
  - The filter requires `completedAt <= now` and `startedAt <= completedAt`.
  - `verifiedAt` = max(`capturedAt`, `startedAt`), and `now >= verifiedAt` is still enforced, so a future `capturedAt` is rejected as before.
- **Raw provenance stays intact.** `verifiedAt` only exists in memory (an optional type field) and in evaluation evidence, next to the unchanged `capturedAt` and `snapshotId`. Stored snapshot rows and payloads are not rewritten.

## Your lower-bound reasoning

- The handbook uses its own `NinjaEconomyClient` instance (`process.ts:85`), and collection is sequential inside a refresh that runs one at a time (`localConcurrency: 1`).
- So a `fetched` or `revalidated` result comes from an HTTP request made after that attempt's `startedAt`. The client's shared in-flight requests can't be joined from elsewhere, which keeps `startedAt` a safe lower bound.
- The orchestrator receives the full repository (`process.ts:258`), so `listAttempts` is available. If it were missing, the attempt list would be empty, which fails closed.

## Prior P2 scenario

- Ninja collected at T0, market jobs finish at T0+35, and the pre-publication call makes an HTTP request (cache max-age expired) that returns 304 or the same hash.
- That creates a `revalidated`/`fetched` receipt with `startedAt` ≈ T0+35, so the materials are accepted.
- If the client served a cache hit instead (max-age longer than the refresh), the materials stay withheld. That is the correct fail-closed result.
- Converting the material price uses `verifiedAt` as its price time, and the currency-snapshot window is measured from `verifiedAt`. The trade collector's own conversions use the raw repository row, so they still use `capturedAt` and are unchanged.

## Remaining acceptance limits (unchanged, not new)

- **Accepted conservative limit:** if a rate-limited batch takes more than 30 minutes, expired base and output snapshots are still withheld.
- `listAttempts` reads only the latest 100 attempts across all leagues. If the proof has been evicted, the material is withheld.
- A Ninja `max-age` longer than the refresh means a cache hit before publication, so a slow refresh still withholds materials.
- **Carried over:**
  - Rows without `rawListing` are matched with their old normalisation.
  - The lowest-price page assumes the trade site's own currency sort.
  - The pg-boss refresh job expires after 60 minutes.
  - An orphaned `running` cycle blocks new triggers.
  - CoE inputs are rounded, so economics are indicative, and prices are asks, not completed sales.
  - The migration test only covers `recipe_evaluations`.
  - Handbook pricing needs both `POE_TRADE_ACCESS=owner_permitted` and an authorised Trade-compatible source.
- **Not verified by me:** live cycle `c2ce6924` and its reported numbers, and the test and CI results you listed.
