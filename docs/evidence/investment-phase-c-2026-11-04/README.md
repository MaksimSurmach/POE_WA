# Phase C — signals, liquidity and capital allocation

[PR33](https://github.com/MaksimSurmach/POE_WA/pull/33) depends on Phase B PR32 (`61b47f4`), which depends on Phase A PR31. Reviewed runtime: `dd1229fdab503e069567270df8673b7a527596df`. No merge, deployment, provider scraping or real trades.

## Acceptance evidence

This directory records completed implementer checks and independent Claude Code review at the final reviewed runtime revision. Subsequent evidence-only commits do not change runtime code.

- Migration0027 preservation complete: all34 existing tables retained identical row counts/content digests. The isolated copy includes a persisted Phase A model and three synthetic Phase B batches with26 events. Three intelligence tables were added. See [migration receipt](migration-preservation.json).
- Full unit suite passed:173 domain,21 contracts,125 web,467 server, plus local-runtime check. Provider contracts7 passed; build/typecheck/lint passed.
- All8 browser scenarios across A/B/C passed in Chromium at1440px and390px. C creates a positive plan through the real API/PostgreSQL mapper, preserves the original planning FX, retries idempotently, restores the saved plan, inspects liquidity/history, expires snapshots, then holds capital while the historical plan remains unchanged.
- PostgreSQL integration161 and backend E2E8 passed after all review corrections. Regressions cover partial settings updates, coherent whole-feed retries, bounded retryable503, final-time quote expiry and policy changes during evaluation. All final local checks passed at the reviewed runtime revision; CI is tracked on PR33.

[Desktop plan](desktop.png) · [Mobile plan](mobile.png) · [Synthetic plan receipts](synthetic-plans.json).

The labelled acceptance scenario has5 independent asking sellers, at least3 own confirmed exact-output sales,1day median listing time and2day median holding time. With2div at an explicit100c/div assumption,0.5div requested reserve and10% maximum exposure, it selects one10c saved objective with190c simulated cash result. Remaining190c includes the reserve. This is a deterministic test scenario, not a live opportunity or evidence of game returns.

## Product boundaries

Liquidity from marketplace snapshots describes observed listing supply and advertised prices. A disappeared listing is never counted as a sale. Completed sales and holding times come only from the owner's explicit Factory records and exact output signature/league.

Allocation is advisory. A line selects one whole saved simulation objective; neither per-item P95 nor simulated profit is represented as a historical result or multiplied into a claimed portfolio percentile. Missing evidence leads to a watchlist or holding cash. Exact assumptions, evidence and calculation versions remain attached to saved decisions/plans.

No current live market opportunity has been verified by these deterministic acceptance scenarios. Synthetic fixtures are labelled, use the isolated database and cannot be presented as completed game trades.

## Deliberate limits

- Production recommendations require fresh supported market-observation resale quotes; manual resale assumptions and individual past transactions remain usable for scenario EV but cannot create CRAFT.
- The allocator requires at least3 exact-output own holding-time samples in the selected horizon, complete own coverage and remaining observed capacity after unsold stock. Otherwise it holds cash. Historical completed sales cap trial production; they do not prove future demand.
- A line selects one whole stored simulation option per recipe, bounded to20 options/recipe. Target-success objectives with saleable failure outputs stay watchlisted until their additional output quantities can be bounded; fixed-attempt objectives can use supported salvage cohorts.
- Accounting and allocation comparisons use chaos. Entered chaos/divine capital conversions retain their explicit planning source. Non-chaos risk objectives cannot become allocation candidates.
- Simultaneous Monte Carlo sampling bounds are conditional on the declared model and stored output valuations. They do not include failure to sell within the horizon, price movement, liquidation or holding risk. They do not validate probability assumptions or guarantee future prices/sales. Greedy selection is deterministic and feasible, not globally optimal.
- Current opportunity reads are capped at50 recipes. Intelligence pages exact-output Factory cohorts independently in50-batch pages, preserving old unsold stock; its10,000-batch/10,000-row per-cohort bounds explicitly mark incomplete coverage. The separate Factory summary retains its100-batch limit. The existing process refreshes10 recipes per minute and views reconcile against stored evidence. No provider fetch is triggered by opening these views.
- No live-market production opportunity, real transaction, production migration, deployment, Safari/physical-device or screen-reader-speech verification was performed. The existing web bundle-size warning remains.

## Independent review corrections

The [initial Claude review](claude-initial-review.md) found two medium defects: older risk options could bypass the current thresholds, and a global Factory-history cap could hide relevant unsold stock. Both were corrected, alongside policy hysteresis, chronological writes, recurring decision history, divine-quote conversion and explicit conditional-risk wording. The [second review](claude-second-review.md) accepted the financial and data-integrity corrections and found a whole-feed concurrency availability regression plus a lost local notification; both are corrected. The [final Claude review](claude-final-review.md) is PASS at `dd1229f`, with no blocking regression. Reviewer reads are separate from implementer-run tests.

Residual review limits: a new browser tab may re-announce an older local emission because deduplication is per session; wording always identifies the current state. A backwards system clock or an older usable observation can temporarily fail closed with retryable503 until chronology catches up. Worst-case latency at the documented cohort limits has not been load-tested. These do not justify relaxing freshness or financial integrity checks.
