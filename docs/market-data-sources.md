# Market data sources

Reviewed against primary documentation on 2026-10-30.

## Public economy data

[poe.ninja's API documentation](https://poe.ninja/docs/api) permits its documented
economy overview endpoints. Worksmith's `NinjaEconomyClient` uses only:

- `/poe1/api/economy/leagues`
- `/poe1/api/economy/stash/current/item/overview?league=...&type=BaseType`
- `/poe1/api/economy/exchange/current/overview?league=...&type=...`

Exchange categories are explicitly limited to Currency, Essence, Fossil and
Resonator. Currency comes from `core.primary`; BaseType estimates are denominated
in chaos. The connector identifies the application, shares a bounded cache,
uses ETags, respects caching and Retry-After, and limits concurrent requests.
It preserves the original capture time after a 304. Source update time is null
when the provider does not supply it.

These are category estimates and exchange aggregates, not a valuation API for
arbitrary crafted rare items. Currency exchange volume is not equipment sales
volume. The UI and storage keep economy snapshots separate from rare listings.

## Rare listings and GGG authorization

[GGG's developer overview](https://www.pathofexile.com/developer/docs) currently
states that new application registrations are paused. Only the API Reference and
Data Exports are supported. Internal Trade Search requests are not a documented
developer API and are not used by the new workbench.

An already approved confidential OAuth application with `service:psapi` can use
the [Public Stash stream](https://www.pathofexile.com/developer/docs/reference).
It is a change feed, not a query endpoint for a chosen item profile. A future
connector needs a cursor, stash replacement/unlisting semantics and a bounded
operational plan. Unlisting is not proof of sale.

The workbench does not request a Path of Exile password or POESESSID. If personal
account features are added later, use GGG's documented OAuth flow. Keep client
secrets and tokens on the backend. A new token does not grant an undocumented
trade scope.

`MARKET_COLLECTION_SOURCE` selects `manual-import` (the default) or `disabled`.
No automatic Trade transport is available: the existing `PoeTradeClient` calls
the undocumented Trade endpoints, so the collection path does not reuse it for
network access. It does not copy Awakened PoE Trade's session proxy or cookies.

User imports are saved transactionally to both `market_research_snapshots` and
`market_collection_runs`. The ranking and matcher continue to use the same
immutable snapshot and analyzer. Manual observations are marked partial: they
contribute compatible priced rows and positive ID changes, but cannot prove
that absent listing IDs disappeared. The first observation is a baseline.
Unpriced and differently denominated listings remain in raw history and do not
contribute to price estimates. The importer retains listing currency, fee,
listing time and an optional raw listing envelope alongside original item JSON
and capture time. The query digest includes the immutable target and exact
source URL, which normally contains the saved Trade search identity. Use the
same saved search URL when comparing observations. The UI keeps missing
properties unknown.

The bounded detail seam accepts null response slots and missing prices. Such
slots reduce fetched coverage and remain partial; they are not schema errors or
evidence that an offer was sold.

The bounded 10-ID transport adapter remains an internal seam for a future
supported, authorized source. It is not enabled by either configuration value.
Replay fixtures remain demo-only. Never use an undocumented endpoint or copied
desktop identity to enable it.

GGG's separate public Currency Exchange CDN provides historical hourly digests
without an OAuth key. It can inform crafting-input costs; its historical data
and currency semantics must not be interpreted as current rare-item prices.

## Builds and item definitions

poe.ninja's internal builds, profiles, character and PoB endpoints are explicitly
unavailable for third-party integrations. M1 starts with source links and curated
requirements. User-supplied PoB parsing is subsequent work; separate item sets
must retain their progression/budget context.

[RePoE exports](https://repoe-fork.github.io/) provide base and modifier reference
data. Pin the export/commit and game patch when importing it. The software's MIT
license does not relicense the underlying GGG game data. Preserve unknown mod
IDs, tiers and affix roles as unknown. The [GGG changelog](https://www.pathofexile.com/developer/docs/changelog)
documents item modifier schema changes that make raw archival necessary.

## Previous leagues

The current economy overview contract does not establish a complete historical
rare-item archive. Import history only from a verified, available dataset with
explicit provenance and coverage. Do not manufacture a previous league's market
from today's prices or a sparkline without timestamps.

## What is still unverified

Tests with injected HTTP responses validate application behavior, not availability
of an external source. A real league discovery request and a bounded real economy
capture must succeed before a deployment is described as collecting live data.
Persistent PostgreSQL behavior likewise requires the isolated database integration
tests; an in-memory fixture is insufficient evidence of restart durability.
