# Market M1 progress — 2026-10-29

## Verified in this checkout

- PR #22 is open on `work/market-intelligence-2026-10-29`; do not merge before review.
- API, UI and local PostgreSQL 17.11 are running from `.env.development`; migrations through 0017 are applied.
- Real poe.ninja Allflame / BaseType capture persisted in PostgreSQL: snapshot `11a7536e-24f8-4ae4-baf4-a35f485a678b`, 9,334 rows, captured `2026-10-29T07:35:51.467Z`; attempt journal marks it `fetched` and successful.
- UI reads the persisted snapshot and journal after API restart. Browser screenshot: [economy and guide library](../output/playwright/market-economy-desktop.png).
- Seed command persists ten checked guide-based targets across five builds and is idempotent by target digest. Guide recommendations are explicitly not market-demand evidence and are tagged for PoE 1 patch 3.29.
- Manual rare-item import remains user-selected. A demo-only empty import was deduplicated and removed; no rare prices were fabricated. The actual rare-item import/history workflow still needs a real, permissioned observation to qualify as live-data acceptance.
- Raw economy payload retention defaults to 90 days; summaries to 730 days. Both are configurable with `MARKET_ECONOMY_RAW_RETENTION_DAYS` and `MARKET_ECONOMY_SUMMARY_RETENTION_DAYS`. Overview applies cleanup; expired payload summaries remain visible and disabled.
- `pnpm build`, `pnpm test` (254), `pnpm lint`, and `pnpm db:check:migrations` passed. Integration tests are rerunning against sourced `.env.test` after an initial invocation omitted the required environment.
- Local Node is 24.17.0, outside the supported Node 22 range. Fresh CI on the pushed head is required.

## Remaining acceptance gates

- Finish the current isolated PostgreSQL integration run and browser checks for import/history, stale/minimum sample, source failure, and unavailable DB.
- Review screenshots at desktop and narrow widths after the source-library layout fix.
- Push the completed changes, verify fresh PR CI, inspect review comments, and sync Linear to evidence.
- M1 is not complete until the remaining live rare-item path is validated with a real permissioned comparable observation and all required UI states are checked.

## Next step

Commit and push the verified changes, wait for fresh CI on PR #22, review comments, and sync Linear. Keep M1 marked in progress until the real rare-item path and remaining UI states pass.
