# MAX-1287 durable import follow-up — 2026-10-31

## Checkpoint 1: audited starting state

- PR #24: open/draft, head `f19831df62c3a15e241262319063b738ca307f4d`, base `codex/max-1287-belt-opportunities` / `dabb2f1e42aa6cc1df829d0239bbf2e72e5cdc30`; quality CI succeeded.
- Isolated worktree: `poe-max-1287-durable-import`, branch `codex/max-1287-durable-import`. The primary checkout's untracked `.DS_Store`, `poe-build-research-v1/`, and `research/` were left untouched. No MAX-1288 files changed.
- Scope: collection manager/history, shared PostgreSQL limiter and its in-memory implementation, repository recovery, idle DB connection handling, associated tests and this report. One optional JSON field preserves a terminal outcome while publication is pending; no dependency or migration added.
- Deployment inspected: `compose.yaml` has one PostgreSQL 17 instance. “Replication” is treated as collector coordination through this database; DB HA was not requested or added.
- Independent audit found unrecoverable publication failures, upload-time history ordering, lost limiter policies/headerless resets, ignored 503 Retry-After, and a crash/late-success denial race.

## Checkpoint 2: corrections and first checks

- Terminal raw can be republished under a row lock. Stale redeliveries cannot replace terminal evidence. Recovery publishes interrupted raw as partial, retaining its error and original timestamp.
- History uses observation time, then stable upload-time/ID ordering.
- Search/fetch retain their own policy mappings; a shared permit atomically reserves every applicable policy, including legacy `trade` state. Missing headers preserve known windows. Access denial is durable across late successful responses and policy changes.
- HTTP response retries are bounded to three attempts for 429/500/502/503/504. Exponential backoff plus 0–2 seconds jitter is persisted through the same limiter; each attempt checks cancellation and current settings after its permit. Other errors, including 403/challenge, are not retried.
- First focused checks: 50 unit cases passed; before the retry addition, 28 targeted PostgreSQL cases passed. Final checks and independent re-review follow below.
- Existing PostgreSQL data was dumped before verification and restored into a separate PostgreSQL 17 cluster. The source database was not used for destructive tests. The initial restore reported missing owner roles; it was rerun successfully with `--no-owner` on the isolated destination.
- Next: repeat affected PostgreSQL checks, verify historical manual evidence through the actual API/UI, backup/restart/restore fingerprints, independent re-review, then update draft PR #24 without merge.

## Access and evidence boundary

[GGG available resources](https://www.pathofexile.com/developer/docs#available-resources) still do not provide the needed Trade search/details resource. New application registration remains unavailable. The six referenced Awakened PoE Trade files were inspected at `3188208957422b21b69b12083a03edf3d1bac187`; no reference transport was executed or copied.

An ordinary Chrome navigation to Trade showed a Cloudflare security challenge. No challenge was solved, no alternate request was attempted, and no new listing observation resulted. This is a visible challenge, not evidence that authentication is required. Automatic collection remains `manual-import`/disabled; no live HTTP adapter, credentials, session extraction, or production collection was introduced.

Historical October 29 user-selected observations are existing manual evidence, not current October 31 quotes. Synthetic scenarios remain tests. No pair of new real observations has been obtained.

## Checkpoint 3: verified result

- Recovery was independently reviewed again. Two additional findings were fixed: empty-result publication retry and preservation of the original cancelled/rate-limited/failed/blocked outcome. Six PostgreSQL cases now exercise these outcomes with an insert-failure trigger, a new pool, concurrent stale redelivery, recovery, and a second idempotent recovery.
- `publicationResult` retains the original terminal status/error in existing JSON while publication is pending. Legacy publication failures without this metadata keep their recorded failure after snapshot recovery; the lost original outcome is unknown and is not invented.
- A real PostgreSQL restart exposed an unhandled idle `Pool.error`. The shared pool now handles it; the application supplies a logger that receives a fixed message, never the raw client/error. Active-query errors still reject. The behavior follows [current node-postgres documentation](https://node-postgres.com/apis/pool), fetched using Context7 CLI. PostgreSQL integration terminates an idle backend and verifies a new connection. A second real cluster restart left the API process running and its saved state unchanged.
- Manual collection records now retain their source URL. UI history section keys include the semantic query digest, so different query scopes in one currency remain distinct.

| Boundary | Result |
| --- | --- |
| Runtime | Node 22.23.4, pnpm 11.8.0, isolated PostgreSQL 17.11. |
| Unit | 316 cases: domain 68, contracts 10, server 215, web 23. The first full run caught an old contract assertion expecting one normalized endpoint; it was updated for retained endpoint/policy state and the affected contract plus full server suite passed. |
| PostgreSQL | Final full run: 15 files, 69 passed. Covers two processes/shared policies, legacy cooldown, 429/503 Retry-After, cancellation/settings guards, policy/headerless handling, durable denial, raw recovery/publication, snapshots, matcher and ranking. |
| Other checks | Provider/fixture contracts 7 passed; backend E2E 7 passed; typecheck, ESLint, build, migration check and forward migration passed. No migration or Dockerfile changed. |
| Manual/API/UI | Imported the existing five October 29 Winter Orb rows through the actual UI JSON form. Raw rows equal the source file. Reimport returned HTTP 200 and retained one run/one observation. UI displayed 100 chaos, age over 24 hours, partial coverage, baseline counts of zero, and disabled automatic controls. The matcher returned five PARTIAL rows and zero false MATCH. Ranking changed from no observation to the stored snapshot with INSUFFICIENT_DATA; missing craft/rule evidence and freshness were not fabricated. |
| UI limitations | The correct route is `/`. An initial `/market` navigation emitted route warnings; no application error was seen on the correct route. Chrome's file-upload permission was unavailable; the JSON textarea was used without changing browser permissions. No new mobile layout change was made or re-tested. |
| Backup/restore | An existing database's records were preserved in a separate restored database, then the resulting manual-import database was dumped/restored again. Both copies have 2 targets, 3 snapshots and 3 runs. Profile, raw-run and snapshot fingerprints match after restart; forward migration opens the restored DB successfully. |
| Review | Independent audit and two correction reviews completed; final review found no actionable issue in changed boundaries. |

Machine-readable evidence: [manual path](evidence/max-1287-durable-manual-validation-2026-10-31.json), [backup/restart/restore](evidence/max-1287-durable-backup-validation-2026-10-31.json). Local check logs are `/tmp/max1287-durable-*.log`; dumps stay outside Git.

PR #24 remains draft and stacked on PR #23. No merge, production schedule, DB replication, new queue, or new platform was added. Local test servers are stopped after validation. Current quotes, two new independent real observations and live transport remain unverified; the next live step requires a supported resource or explicit GGG permission and fresh user evidence. The existing historical profile is insufficient for a confirmed craft-profit recommendation.
