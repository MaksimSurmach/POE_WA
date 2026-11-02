# Market admin implementation review

Reviewed source: `75cb6e4fca99a95197037aa19a638b992c911377`, based on PR #26.

## Local review

Completed nine independent review passes covering correctness, testing,
maintainability, security, performance, API contracts, migration safety,
reliability and frontend races. No retained code findings remain after fixes.

Fixed and rechecked:

- Selected-recipe publication uses its own success threshold and carries other
  evaluations forward without advancing their capture/evaluation times.
- Maximum quote age uses the oldest contributing input; stricter policies fail
  closed for legacy inputs whose age cannot be proved.
- Publication locks the administrative run, refuses accepted cancellation and
  marks successful runs in the same transaction. A two-connection PostgreSQL
  regression verifies the cancellation race and late-cancel rejection.
- UI actions block overlapping polls and discard older responses.
- Purged historical raw evidence cannot appear as an empty analysis sample.
- Runtime schedule reconciliation avoids rewriting an unchanged schedule.

Review receipt: `status: complete`, run `20261102-172909-6474370f`.
The local receipt initially records `Not ready` because the separately required
Claude Code verification had not completed.

## Claude Code

Two read-only attempts requested `claude-opus-5` at high effort and timed out
without a completed answer. The second stream identified the requested model and
generated reasoning, but supplied no final review; it is not counted as completed
verification. No authentication or unsupported-model failure was observed.

A shorter, low-effort review on the same Claude Code/model route is pending.
This file will be updated with its actual result before final delivery.

## Coverage limits

Scheduler disablement, cron changes, pending shutdown and signal forwarding have
regressions. Rejected/overlapping reconciliation ticks are not directly asserted.
Cancellation is covered across store, scheduler, orchestrator and the actual
publication transaction; the complete process polling callback with a blocked
provider is not directly exercised. Automated frontend coverage is client/static
rendering; actual desktop/mobile browser controls were exercised separately.
