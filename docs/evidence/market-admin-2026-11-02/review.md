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

A complete read-only Claude Code review subsequently succeeded on the same model
route at requested low effort. Assistant/server usage metadata identifies
`claude-opus-5`, provider `firstParty`, successful terminal completion, no tools,
no subagents and no permission denials. Actual served effort is unverified.

It reported two claims:

- Accepted P2: a deployment TTL above 30 minutes could seed settings inconsistent
  with the initial maximum quote age and block unrelated patches/pause/resume.
  The seed now caps TTL at that age and validates before insertion. Two real
  PostgreSQL regressions verify a one-hour environment TTL, unrelated edits,
  pause/resume and rejection of an inconsistent seed without insertion.
- Rejected P1: a selected refresh on a cold/new league supposedly drops other
  recipes/prices. `readCatalog` enumerates every active recipe independently of
  evaluations. A cold league has no same-league published prices to lose; older
  league prices must not be reused. Existing same-league evaluations are carried
  unchanged. The proposed cold-start ban would prevent permitted selected refresh.

The corrected seed passed local source review and PostgreSQL regressions. The
final narrow Claude recheck returned first-party API 429 `usage_limit_reached`
before inference. It did not review the fix; no post-fix Claude approval is
claimed. The completed independent full review, the accepted fix and local/CI
verification are separate evidence.

Final local review also checks that history retention cannot expire a stored row
before its configured raw retention; the invalid policy is rejected and covered
by a PostgreSQL regression. The UI explains this relationship.

[Sanitized Claude receipt and verified source hashes](claude-review-receipt.json).

## Coverage limits

Scheduler disablement, cron changes, pending shutdown and signal forwarding have
regressions. Rejected/overlapping reconciliation ticks are not directly asserted.
Cancellation is covered across store, scheduler, orchestrator and the actual
publication transaction; the complete process polling callback with a blocked
provider is not directly exercised. Automated frontend coverage is client/static
rendering; actual desktop/mobile browser controls were exercised separately.
