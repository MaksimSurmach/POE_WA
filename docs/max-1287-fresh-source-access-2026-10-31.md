# MAX-1287 — fresh observation access, 2026-10-31

## Verified starting state

PR #24 remains open/draft at `c23bbfc1ffa1b3dcc0f7dae566bb174925a5a8bd`, based on `dabb2f1e42aa6cc1df829d0239bbf2e72e5cdc30`. Its quality CI passed. The isolated continuation worktree was clean; the primary checkout and MAX-1288 data were left unchanged. No code, migration, transport or catalog change is needed merely to investigate access.

## Supported access routes

| Route | Permission and usefulness | Current boundary |
| --- | --- | --- |
| GGG Public Stash API | Documented rare-item data via `GET /public-stash-tabs`, confidential OAuth client, `client_credentials` and `service:psapi`. Five-minute delayed stream; pagination and stash replacement/unlisting must be tracked. | No such application credentials are configured in the repository's environment files. The owner's existing approval is unknown, not disproved. No unauthenticated probe or token request was sent. |
| Ordinary Trade UI followed by explicit import | Can supply fresh user-selected asking-price observations through the existing importer. This verifies a fresh manual path, not an automated Trade HTTP adapter. | One ordinary Chrome navigation showed a Cloudflare security check. The same page was still a check when inspected again; no results were received. The owner was asked to complete the normal check manually. No CAPTCHA action, alternate host/IP, copied cookie/identity or hidden API request was used. |
| GGG Currency Exchange CDN | Documented public hourly historical currency aggregates; can support input-cost research. | Does not provide rare-belt listings and cannot satisfy the rare-observation gate. No substitute currency capture was performed. |

Primary references checked directly and via Context7 CLI:

- [Supported resources and application registration](https://www.pathofexile.com/developer/docs#available-resources): new registrations remain paused; undocumented internal Trade search/details are not supported resources.
- [Public Stashes](https://www.pathofexile.com/developer/docs/reference): documented stream, five-minute delay and change cursor.
- [Service OAuth scopes and grants](https://www.pathofexile.com/developer/docs/authorization): confidential clients and `service:psapi`; an ordinary account login or public desktop OAuth client does not grant this service scope.
- [Currency Exchange](https://www.pathofexile.com/developer/docs/reference): historical hourly aggregates, excluding the current hour.

The accurate distinction is **a supported rare-item source exists, but authorized application access is not currently available to this run**. This differs from saying that GGG has no supported rare-item data at all. Public Stash is not a drop-in replacement for the existing profile-search/detail test seam; no speculative stream/indexing platform was added.

## Prepared acceptance boundary

The existing local PostgreSQL state was backed up before any fresh import. It contains two targets, three snapshots and three runs, with zero enabled schedules. The API/UI were opened only on loopback for a bounded validation window. The collection manager's scheduler was not started. Production collection remains off.

The real-data gate needs two independently observed, non-replay/non-cache samples of one immutable profile, league, currency and exact saved search/filter scope. Preserve the original rows, available listing IDs, observation times, source URL/filter description and actual coverage. Equal contents can be a new observation only when there is evidence of a new source observation; a cached redisplay or a changed timestamp on old rows does not qualify. Missing IDs/properties stay unknown. Manual partial selections cannot prove disappearance or sales.

After genuine source data becomes available, import each sample through the existing endpoint, verify two distinct durable observations and compatible scope, inspect matcher outcomes and the ranking's linked latest snapshot, and confirm the update in the UI. Fresh manual imports can satisfy the issue's real-import path; they do not establish automated collector access or current craft profitability. No missing property or crafting cost may be invented to force a numeric ranking.

## Current result

**Fresh real observations: 0 of 2. Live acceptance: NOT MET.** No historical record was restamped, no fixture was relabelled, and no fresh price or sale is asserted. Ranking remains linked to the October 29 observation with `INSUFFICIENT_DATA`. The source-access questions require an owner response: normal Trade UI access, or confirmation of an already approved confidential application. Secrets must stay outside chat, Git and evidence.

No tests were rerun because application code is unchanged; the verified CI still belongs to `c23bbfc`. No merge or production collection was performed.

The source-access report was independently reviewed without network/test reruns; no factual issue was found. The local validation servers were stopped, and the Trade tab was retained for the owner’s normal security check.
