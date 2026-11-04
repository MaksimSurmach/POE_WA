# Phase A — outcome economics and risk acceptance

Baseline: master `7387f7c` (merged PR30). No newer open PR existed at implementation start. This phase is the base for the Factory and Intelligence PRs; it is not merged or deployed.

## Working behavior

- Optional outcome graph belongs to one recipe method. Stages model conditional outcomes and retries; conditional probabilities must normalize exactly, with explicit unknown residuals. Values, probabilities and costs retain provenance. There are no invented default rates and no `craft.variants`.
- Decimal graph expectations include base/material/finishing/recovery costs, resource credits, salvage revenue, valuation ranges, EV/ROI, break-even prices and sensitivity. Missing/stale/mismatched evidence, overlap and non-absorbing graphs fail closed.
- Seeded risk simulations separate fixed method runs, one target and N targets. Setup is paid once; consumed starting bases are replaced before another run. Reusable failures retain the base. Simple geometric cases use an analytical distribution.
- Immutable saved models bind recipe content hash, target signature and league. Persisted simulations retain exact inputs, quotes, version and seed; owner-only endpoints enforce idempotency, revision checks, a bounded queue, cancellation and restart recovery. Opening a recipe reuses saved market evidence and does not collect the market.
- Recipe details provide explicit owner model entry, EV/salvage and sensitivity, budget/objective/seed controls, progress/cancel, distributions or deterministic-cost explanations, quantiles and an assumption-labelled next-action comparison. Reload restores the saved objective and result.

## Numerical and integrity acceptance

- Reusable-base single-target example: expected cost 18. Destroyed failure bases: 48. Two targets require replacement bases: 36; no extra base is purchased after the final target.
- Golden cases cover conditional stages, salvage/recovery, negative EV, unknown and tiny probabilities, currency/evidence mismatches, exact normalization and non-absorption.
- Monte Carlo checks include seeded repeatability, known negative-binomial means and quantiles against an analytical CDF with a DKW rank bound, bounded operations and cancellation. Censored runs do not publish tail/loss estimates.
- PostgreSQL/API checks cover optimistic revision races, conflicting idempotency, repeated jobs, queue capacity, cancellation/completion races, restarted workers and reproduction from stored inputs.
- Unit tests, contract tests, PostgreSQL integration, backend E2E, typecheck, lint, build and migration validation passed. Browser E2E passes desktop/mobile model entry, rejection of missing residual probability, saving, simulation, reload and cancellation with no partial risk result.
- Migration0025 was applied to a separately seeded PostgreSQL17 database at localhost:54328. All 29 old table row counts and content digests were unchanged; only `craft_outcome_models` and `craft_risk_runs` were added. See [preservation receipt](migration-preservation.json).

## Browser evidence

[Desktop](desktop.png) and [mobile](mobile.png) show the existing recipe route with an explicitly synthetic model in Fixture League. These are not live economic recommendations. The fixture costs 12 chaos per method run and has mutually exclusive 50% target (100 chaos) / 50% salvage (10 chaos) outcomes: EV43 and expected salvage5. The saved Monte Carlo results and cancellation receipt are in [synthetic-simulations.json](synthetic-simulations.json).

Reproduce on a dedicated local `poe_worksmith_test` database: set `APP_ENV=test` and `TEST_DATABASE_URL`, run `pnpm db:migrate`, `pnpm build`, `pnpm exec playwright install chromium`, then `pnpm test:e2e:browser`. The browser harness resets only that dedicated test database and refuses the native runtime port54326. It starts API4317 and web4176; it does not start the user's installed services. CI runs the browser tests after the existing integration/build checks.

## Limits

Existing live recipes do not automatically gain verified salvage distributions. Their EV remains unavailable until a complete explicit model and adequate valuations exist. The basic form describes one terminal method run; conditional stages and retries use the advanced graph editor. A method run is not an individual currency-roll cutoff. Risk on resale intervals remains unavailable without a justified distribution; EV ranges remain visible.

Simulations are bounded to 16 stages, 16 outcomes per stage, 10,000 trials, 2,000,000 total transitions and a 30-second server deadline. Truncation is explicit and does not masquerade as a completed distribution. Bankroll metrics use gross crafting spending, without assuming interim sales fund later crafting. No new live provider collection, in-game rolls, executed sales or native deployment was performed.
