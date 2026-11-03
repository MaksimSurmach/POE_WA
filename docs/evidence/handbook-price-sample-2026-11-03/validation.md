# Bounded handbook price samples — 2026-11-03

Handbook targets with slot `starting-base` or `crafted-item` fetch the first
20 returned IDs, in the existing sequential groups of 10. Research targets keep
their 1,000-detail limit. Search evidence retains all returned IDs, the provider's
reported total and raw search response; none is rewritten to pretend only
20 offers existed.

The new optional `sortedSampleComplete` flag is distinct from
`sortedPageComplete`. It requires a strict captured query with only ascending
price sort, all 20 unique first IDs present in the fetched details, consistent
returned counts, a larger reported result total, and no inexact result,
cancellation or error. A sample does not receive the complete-provider-page
flag. A fully fetched result below the cap can still have complete coverage.

The flag survives durable collection records and the managed provider adapter,
then reaches new raw snapshots, observation summaries, publication and public
views. Running checkpoints cannot retain the proof; an interrupted checkpoint
fails closed. The provider independently rechecks sample membership. Incomplete
partial samples retain raw evidence but withhold aggregated prices and recipe
cost/ROI. They also miss the planner cache, so unusable partial data is retried.
Old raw snapshots are not modified.

Complete samples remain **partial coverage** with **low market confidence**.
This also applies when only the starting base is sampled. Exact matching and
seller deduplication remain unchanged. The UI labels `sorted price sample:
20/total offers`, separately from the verified seller count; starting-base price
evidence carries the same qualification. Profit is labelled indicative, and
one or two verified sellers are marked as a thin market.

Verification on Node 22.23.4 / pnpm 11.8.0:

- 81 focused source, durable-manager, provider-to-publisher, cache and job tests
  passed, including capped/full research behavior, strict sort/scope, actual
  first-20 membership, missing details, foreign IDs, cancellation, inexact
  search, complete versus incomplete publication and base-only low confidence.
- Seven provider contract tests and 63 frontend tests passed.
- Workspace build, lint, typecheck, changed-file formatting and diff whitespace
  checks passed.
- No database, provider, scheduler or permission setting was changed by this
  implementation task. Integrated PostgreSQL and live-source validation belong
  to the root release run.

The actual Claude Code review attempt hit the five-hour quota before a review
completed; `claude-attempt.json` preserves that failure. No Claude approval is
claimed for this delta. A separate agent review was requested from the runtime
reviewer.

The fixed cap bounds requests; it does not guarantee a whole-catalog runtime or
quote freshness window. Twenty sorted asks are a selected sample, not population
coverage, completed sales or liquidity proof. Expected craft quantities remain
separate from asking-price evidence, and unavailable quantities still leave
expected totals and ROI unestimated.
