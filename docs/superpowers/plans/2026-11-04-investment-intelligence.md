# Crafting Investment and Production Intelligence Implementation Plan

> For agentic workers: execute phase by phase with independent implementation ownership and Claude Code review. Do not merge or deploy. User explicitly authorizes progressing between internally validated phases without an approval pause.

**Goal:** Support outcome-aware crafting investment decisions, actual production accounting and evidence-backed production allocations in the existing Worksmith application.

**Architecture:** Extend the existing single-method recipe with an optional provenance-bearing stochastic stage graph. Reuse Decimal, Zod/Fastify contracts, PostgreSQL repositories, saved market evidence and React routes. Layer an append-only production ledger and evidence-based intelligence on the reviewed economics implementation; no second engine/catalog/service.

**Tech Stack:** Node 22, pnpm 11, TypeScript, Decimal, Zod, Fastify, React, PostgreSQL 17, Drizzle forward migrations.

**Spec:** User's “Worksmith — Build a Crafting Investment & Production Intelligence System” instruction in this chat; the acceptance mapping below retains all implementation obligations.

## Global constraints

- One recipe = one exact target item specification + one crafting method; ordered stages/outcomes never become craft.variants.
- English-only UI. Existing components/icons/responsive compact tables. No unrelated redesign.
- Original currencies and transaction-time conversion preserved. Decimal monetary calculations.
- Unknown probabilities, missing residuals, incomplete coverage, stale/cross-league evidence and one seller never create a profitable-production claim.
- Asking prices are not completed sales. Disappearing listings are not sales. Simulations are not observations.
- Production, inventory, model and simulation mutations require existing administrative access and idempotency; concurrent requests must not double-count.
- No real purchases/trades, new scraping, production migration or deployment. Isolated PostgreSQL test data only.
- Three dependent PRs, each with numerical/API/DB/browser acceptance and Claude review before the next phase starts.

## Review focus

1. Missing residual probability and non-absorbing/reachable retry loops: unavailable economics rather than silently normalized/finite estimates; Phase A graph tests.
2. Truncated Monte Carlo paths: explicitly censored/no fabricated tail quantiles, loss estimates or guaranteed target completion; Phase A resource-bound tests.
3. Retry/correction/concurrent sale: deterministic ledger projection and transaction locks/idempotency prevent duplicated money and inventory; Phase B integration tests.
4. Old/model-revision/mixed-currency observations: cannot create fresh signals or rewrite historical transaction profit; Phase A/B/C evidence tests.
5. High ROI but no saleability/budget/diversification: allocator holds cash/watchlists, quantities integral, tail bankroll and reserve honored; Phase C tests.

## Baseline inspection

- Master 7387f7ce60539eea1a4453e51f9c064cf158360d; PR30 merged, no open newer PRs at inspection.
- Existing expectedMethodMaterialUsage/calculateMethodMaterialEconomics/compareCraftWithAsk retain single-target economics and safeguards.
- catalogPublisher, recipeMarket, snapshots, price history migration0024 and market admin remain owning market pipeline.
- Existing local-admin guard rejects forwarded/remote/browser-origin spoofing. Extend it to new financial/model mutation routes.
- Existing React recipe detail, /recipes and market history are reused. Add Risk section, then My Factory and integrated opportunities/plan.
- Existing evidence documents explicitly limit CoE expectations, market asking prices and incomplete sorted samples; those limits persist.

## Phase A — PR A / codex/craft-economics-v2

### A1 Domain economics and risk

Files: packages/domain/src/outcomeModel.ts, outcomeEconomics.ts, craftingRisk.ts, recipeSchema.ts and numerical tests.

Interfaces: outcomeModelSchema/OutcomeModel; outcomeAnalysisInputSchema/OutcomeAnalysisInput; analyzeOutcomeModel(input):OutcomeAnalysis; riskSimulationRequestSchema/RiskSimulationRequest; simulateCraftingRisk(input,{signal,onProgress}):Promise<RiskSimulationResult>.

- [x] Validate stable IDs, per-stage mutually exclusive conditional probabilities, residuals, source evidence, stage targets, bounded inputs and reachable/absorbing states.
- [x] Calculate expected base/material/finish/recovery costs, terminal gross/salvage recovery, net EV/ROI, break-even output/material costs and sensitivities with Decimal. Preserve valuation intervals and precise unavailable reasons.
- [x] Classify explicit outcome requirements/precedence and expose evidence-dependent sell/continue/recover/stop comparison.
- [x] Seeded bounded simulation separates fixed attempts, target-success count and one-target objectives. Report quantiles, budget exceedance, loss, profit distribution, tail shortfall, success within N and confidence bankroll; never discard censored paths.
- [x] Golden checks: geometric, two-stage conditional, reusable/destroyed base, salvage, recovery, negative EV, missing probabilities, normalization, ranges, deterministic seed, analytic convergence/resource limits.

### A2 Persistence and API

Files: packages/contracts/src/craftAnalysis.ts; apps/server/src/craftAnalysis*.ts; repositories/craftAnalysisRepository.ts; schema.ts, migration0025; api.ts/process.ts/adminAccess.ts.

- [x] Immutable model revisions by recipe hash, league and target signature, persisted explicit price/value overrides and assumptions. Optional recipe-embedded model supported without catalog duplication.
- [x] Existing saved market quotes only; exact outcome signature and full freshness/seller/coverage/currency evidence required. Unsupported salvage valuations remain unknown or explicitly user-confirmed.
- [x] Typed EV/model read, owner-only idempotent version-checked save; persisted async simulation jobs with bounded resources, progress/cancel and process-restart integrity.
- [x] Store exact request/model/quote snapshot/version/seed/result for reproducibility. Unit/API/PG integration and migration preservation tests.

### A3 Recipe UI and phase gate

Files: apps/web/src/CraftRiskSection.tsx, styles/tests, RecipePage.tsx, apiClient.ts.

- [x] Compact EV/risk metrics, source and missing-data explanations, budget/objective/size/seed, progress/cancel and meaningful quantile chart.
- [x] Usable explicit owner model/valuation entry; no fabricated live probabilities or auto-labelled fixture observations. Advanced graph JSON optional.
- [x] Baseline/full numerical/contracts/PG/backend E2E, typecheck/lint/build; browser empty/model-save/simulate/cancel, desktop/mobile screenshots.
- [ ] Claude review financial mathematics/data-integrity/architecture; fix material findings, create PR A against master. No merge/deploy.

## Phase B — PR B / codex/factory-ledger (base PR A)

Files: domain factoryLedger.ts + tests; contracts factory.ts; server factoryApi/service and repositories/factoryRepository.ts; migration0026/schema; web FactoryPage and recipe start-batch links.

- [ ] Snapshot recipe/model revision, league, original forecast/evidence at batch creation; explicit status, attempts, timestamps, actual crafting time and notes.
- [ ] Append-only idempotent events for purchases, consumption, expenses, recovery/refund, outputs, allocation, listing, sale and corrections. Transactions serialize each batch; conflicts rejected.
- [ ] Preserve original quantity/currency/unit price/source and transaction-time conversion. Track unused stock/returns and cost allocations separately from cash flow. No duplicate sale, overselling, negative stock or over-allocation under concurrency.
- [ ] Deterministic realized profit of sold items, unsold allocated inventory, cash flow, production spending and salvage separately; confirmed-only sale-time/turnover and forecast comparison.
- [ ] My Factory create/spend/consume/attempt/output/list/sell/correct flow, CSV/JSON export (spreadsheet import optional and not necessary to core scope).
- [ ] Numerical/transaction/restart/multi-currency/partial-sale/correction/migration tests and browser real workflow/screenshots; Claude review/fixes; PR B depends explicitly on PR A.

## Phase C — PR C / codex/production-intelligence (base PR B)

Files: domain opportunitySignals.ts/liquidity.ts/capitalAllocation.ts + tests; contracts intelligence.ts; server intelligence service/API/repository; migration0027/schema/admin thresholds; integrated opportunities/production-plan UI.

- [ ] Exact-target/league/revision listing summaries from existing snapshots: independent sellers, raw comparable listings, distribution/depth/concentration, added/reappeared/missing IDs and supply/price changes. Explicit proxies; no inferred sales velocity.
- [ ] Own ledger sale-duration/turnover samples with actual sample sizes, never transferred across signatures/leagues.
- [ ] Persist signal decisions/evidence; freshness, minimum independent observations, hysteresis, cooldown/dedup; CRAFT/WATCH/STOP/INSUFFICIENT DATA with clear triggers and configurable admin thresholds.
- [ ] Recalculate on market/model/recipe changes without provider fetch-on-view. Cover profit/EV/material/ask/seller/supply/staleness/risk and evidence-status transitions.
- [ ] Integer allocation respecting currency/capital/reserve/horizon/risk/P90-P95 bankroll/exposure/diversification/liquidity; unreliable candidates watchlisted and no eligible plan means hold cash.
- [ ] Persist plans and inputs/decision versions; per-line reason/stop condition, portfolio caveats, sensitivity and conservative/aggressive scenarios. Advisory only.
- [ ] All numerical/API/PG/browser/migration checks and Claude review/fixes; PR C depends explicitly on PR B. Final report links all PRs, evidence/screenshots and precise limitations/readiness.

## Execution ledger

- Inspection complete; original working directory and native runtime preserved. Phase A started in managed isolated worktree. Implementation divided into domain, backend and UI; root owns integration, evidence, database/browser acceptance and review coordination.
- Phase A objective definition: an attempt is one complete execution of the declared method graph, ending at a terminal outcome; internal stage retries are counted separately. A target-success objective repeats that graph until N target outcomes. UI must say “method runs,” not imply individual currency rolls. No individual-stage stopping horizon is claimed in v1.
- Baseline tests passed; build verification collided with in-progress new exports, so it is not recorded as a clean new-worktree build. The reviewed master CI is the immutable baseline; full build will run after integration.

- Phase A integrated code committed as e7e63a6, with numerical/contracts/PG/backend/browser acceptance, migration preservation, typecheck/lint/build passed. Independent Claude Code review running against that exact head.
