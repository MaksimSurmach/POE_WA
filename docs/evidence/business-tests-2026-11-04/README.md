# Business test and recipe audit — 2026-11-04

The test-only follow-up removes assertions that checked fixture counts, table/index names in source, CSS text, registry size and definitions against themselves. Runtime contract parsing, data/rendering behavior, migration checks, retry policy and secret-safe errors remain covered. Catalog integrity still iterates every recipe and rejects an empty catalog.

## Behavioral coverage

- The same material used by two steps costs `(2 × 3 + 1 × 4) × 2 = 20 chaos`, with total required stock 10. Through the catalog publisher, sellers with stock 9 cannot support a cost/ROI; stock 10 supports base 10 + materials 20, ask 300, profit 270 and ROI 900%.
- Missing execution count on a paid finish or unknown quantity leaves expected cost unknown. A material-free instruction needs no execution count and does not invalidate the known cost.
- Prices 10 and 30 give a 25th percentile of 15, a 100th percentile of 30 and an even-sample median of 20.
- Existing numerical checks still cover replacement bases, losses, paid finishing, mixed currencies and the user's example: cost 10 divine, ask 12 divine, profit 2 divine, ROI 20%.

## Deliberate fault experiment

[Machine-readable receipt](mutation-results.json) records exact source replacements and failing assertions. Each mutation ran separately against the entire domain test suite in an isolated temporary source copy. The baseline is `e16857e`; the revised suite is this follow-up. Both unmodified controls passed. This is a targeted experiment, not a full mutation score or a claim about the server/web suites.

| Deliberate fault                                                  | Baseline domain suite | Revised domain suite |
| ----------------------------------------------------------------- | --------------------- | -------------------- |
| Overwrite material usage instead of accumulating between steps    | Missed                | Detected             |
| Remove fractional percentile interpolation                        | Missed                | Detected             |
| Choose the upper middle price instead of averaging an even sample | Missed                | Detected             |
| Treat a missing paid-step count as free                           | Missed                | Detected             |
| Treat unknown material quantity as free                           | Missed                | Detected             |
| Require an execution count for a free instruction                 | Missed                | Detected             |
| Divide profit by sale price instead of cost for ROI               | Detected              | Detected             |

No production formulas were changed: these faults existed only in the temporary experiment.

## Recipe review

Independent read-only review covered all 28 market recipes against archived calculator settings, targets, acquisition constraints, bench vacancy/exclusions, material quantities and finishing stages. It found no new confirmed business defect. Twenty-five have archived models; three incomplete procedures retain no expected executions/base consumption and cannot publish ROI: TR Grizzly helmet, Leviathan minion gloves and Shaper recovery shield. The bare +2 Convoking Wand retains its profitability block because premium market output is not comparable to its modeled endpoint.

The 27 Pohx/Convay summaries were compared with their linked current source pages: 26 remain manual spending scenarios, and Abyss Socket Mittens remains source-unfinished. They do not enter the profitability ranking. See the [Pohx source coverage](../pohx-guides-2026-11-04/README.md) and [flask receipts](../flasks-2026-11-04/README.md).

Current source spot checks support [Twilight Regalia's 302 native maximum ES](https://poedb.tw/us/Twilight_Regalia), [Bone Helmet's 15–20 implicit](https://poedb.tw/us/Bone_Helmet), [Fossilised Spirit Shield's 5–10 implicit](https://poedb.tw/us/Fossilised_Spirit_Shield), and [Enkindling weights](https://poedb.tw/us/Enkindling_Orb). The flask enchant mean remains `650 / 250 × 11 = 28.6`. [Craft of Exile](https://beta.craftofexile.com/) identifies patch 3.29.3.3.

## Validation and limits

The complete workspace unit/contract suite and native-control self-check, typecheck, lint, changed-file formatting and diff whitespace checks passed. An independent reviewer found no concrete issue in the test diff. They reviewed expectations and deleted coverage; they did not independently rerun the mutation experiment.

No runtime code or recipe data changed, so the installed release and stopped services were left untouched. PostgreSQL integration and browser checks were not rerun locally for this test-only change; their earlier receipts apply to unchanged production code.

All 25 calculator models were not independently rederived from current affix weights. Archive consistency is not proof of live probability. In-game craft frequencies and executed sales remain unverified; asking-price ROI is conditional, not realized profit.
