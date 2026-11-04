# Market engine audit — 2026-11-03

Claude Code (`claude-opus-5-5`, reported by the CLI) performed a read-only audit
of costing, probabilities, comparability, currency conversion, publication and
fallbacks. The host inspected each retained finding. Claude reached its five-hour
usage limit before implementing this follow-up; Codex implemented and verified it.

| Finding                                                                                               | Fix                                                                                                                                                                                                                                        | Regression evidence                                                                           |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| A matching unconverted divine ask disappeared from the chaos sample, allowing a false minimum and ROI | Check comparability in the quote's actual currency. Withhold the floor and profitability when matching asks cannot be valued; mark coverage partial. Unrelated rejected divine items do not invalidate good chaos asks                     | Mixed matching / rejected divine listings beside two chaos sellers                            |
| Trade material times were absent from estimate expiry                                                 | Apply the operator maximum age at snapshot resolution. Bound the estimate by capture time and TTL of the Trade materials actually used, selected economy inputs and used FX evidence                                                       | Material expires before output/base; maximum age shorter than cache TTL                       |
| Partial fallback invented a last-success time                                                         | Preserve null success time. Pin missing legacy input time on the first fallback and retain it on subsequent retries                                                                                                                        | Partial → failed refresh → repeated fallback                                                  |
| Unused old currency/economy inputs could expire a chaos-only estimate                                 | Track selected sources and conversion evidence per priced input; omit unused observations                                                                                                                                                  | Fresh chaos-only calculation with an unused old Currency observation                          |
| Collection-time conversions did not bound publication freshness                                       | Retain FX verification time and inspect embedded conversion provenance. Reject missing, wrong-league or expired provenance. A successful revalidation of the same immutable FX snapshot can confirm its rate without repricing the listing | Old embedded FX withheld; recorded verification accepted; same-snapshot revalidation accepted |

The initial regression run failed six tests for the intended defects and passed
the unrelated-item control. Additional proof exposed legacy fallback re-aging and
the same-snapshot revalidation case before their fixes. After the fixes, all 401
server unit tests, server typecheck and repository lint passed. Final integration
and browser evidence are recorded with the market-trends acceptance report.

The existing comparability helper keeps its chaos default; its additional divine
mode evaluates actual divine quotes without changing their values. Other
unsupported currencies conservatively make a fetched price floor unavailable.
No live provider requests, new collector access or schedule changes were needed
for these regressions.

The audit did not find an arithmetic error in the expected-use or ROI formulas.
That is scoped static/test evidence, not certification of every authored recipe.
Superset items, non-executable asking prices and manually verified calculator
assumptions remain limits of the model. Base-depth scaling was not changed:
current authored methods acquire one base. No purchase, sale or in-game craft
was performed.
