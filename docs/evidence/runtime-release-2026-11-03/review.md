# Runtime release hardening — 2026-11-03

Scope: backend runtime layered on `4a36744`, without dependency or schema changes.
This evidence covers runtime fixes, not live Trade access, recipe accuracy or a
GitHub approval. Staging and deployment acceptance are recorded separately.

## Fixes and observed regressions

| Source commit | Failure                                                                                                                                                                                     | Correction and verification                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `e68d93c`     | Production orchestration returned `REFRESH_INCOMPLETE` immediately after a provider scheduled a delayed retry. The process then failed its pending jobs.                                    | Drain delayed retries before evaluation. The existing retry E2E now exercises production orchestration. Unit cases cover success, transient recovery, exhaustion without publication and cancellation during backoff.                                        |
| `c5761c7`     | A queued run older than one hour was cancelled even when another store instance claimed it during reconciliation. The PostgreSQL regression observed `cancelled` instead of `active`.       | Atomically claim expiry with `UPDATE ... WHERE status='queued'`; an already-claimed run remains active. Both this race and ordinary expiry pass.                                                                                                             |
| `68500b4`     | One failed cancellation-status query aborted a healthy refresh; pg-boss aborts were labelled as operator cancellation.                                                                      | Retry failed checks on the next tick, preserve the in-flight guard and stop the timer on completion. Separate worker interruption from operator cancellation. Stop admitting new retry batches after 45 minutes, with the one-hour queue as the final bound. |
| `6d8768d`     | A provider's `MARKET_COLLECTION_CANCELLED` error overrode the worker-abort signal.                                                                                                          | Explicit operator signal takes precedence, then the worker signal, then the provider error. Regression assertions cover a provider cancellation error with worker abort and with both signals.                                                               |
| `bd2e10c`     | Cancellation could deadlock with an in-flight job commit because the two paths acquired job and cycle locks in opposite orders. The controlled baseline PostgreSQL test reproduced `40P01`. | Lock jobs before the cycle. The race regression passes. Abort/finally now stop the run-owned Trade client; runtime shutdown contributes a worker-interruption signal.                                                                                        |

## Independent review

Claude Code 2.1.312 was run in read-only mode with `Read`, `Grep` and `Glob`.
The observed model was `claude-opus-5-5`.

| Review session                         | Scope                                                   | Disposition                                                                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `02a40a23-f8ae-4b89-acd8-2e5e1c738e98` | Backend runtime, recovery, admin security and retention | The cancellation-query failure and worker-abort labelling findings were fixed. Durable enqueue while a worker is unavailable remains intentional; the UI health gate and API queue behavior are now documented. No reproducible admin access bypass was reported. |
| `6fe32c23-0b53-4ced-97a2-73489a612781` | Retry-drain implementation                              | The reviewer requested time before pg-boss expiry for final material prices and publication; the retry budget was reduced to 45 minutes. Cancellation and retry exhaustion were inspected without additional reproducible failures.                               |

The final review (`d7d67de1-b18a-409a-832d-0f3ba31f4030`) reported no
reproducible blockers in the four reviewed fixes. Its additional lock-order
finding was reproduced and fixed in `bd2e10c`; its per-run client ownership concern
was addressed there as well. The read-only follow-up re-read those final corrections and reported no
reproducible blockers. It did not run tests; the results below are from the
local validation runs. Full responses are retained in [the review receipts](claude-reviews.json).

The review's speculative post-publication status concern does not override the
publication transaction: it commits the admin success status with the catalog
pointer, and late terminal writes are guarded by the existing running/queued
condition. Existing PostgreSQL coverage verifies this ordering.

## Validation

Node 22.23.4, pnpm 11.8.0 and an isolated native PostgreSQL 17.11 test database:

- Server unit suite: **47 files / 295 tests passed**.
- Admin PostgreSQL/API/queue suite plus production refresh E2E: **2 files / 48 tests passed**.
- Server and workspace dependencies build and typecheck passed.
- Scoped ESLint, Prettier and `git diff --check` passed.
- The final precedence correction additionally passed its focused cancellation suite.

No existing development or staging database was reset. These runtime checks use
deterministic provider fixtures; they do not establish market prices, in-game
crafting probabilities or production delivery.

The 45-minute retry budget is checked between batches. An already-running batch
can consume that headroom; pg-boss's one-hour abort remains the final bound.
