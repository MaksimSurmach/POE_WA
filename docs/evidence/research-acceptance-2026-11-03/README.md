# Research acceptance and recipe handoff — 2026-11-03

The existing MAX-1288 run completed all six passes within its declared research
scope on 2026-10-30. It produced seven scoped mechanics recipes, one merged alias
and fourteen rejected finalists. This is a usable content handoff, not evidence
of profitable crafting or a deployed product. No external sources, market prices,
player snapshots or simulator runs were recollected during this audit.

All **16 original MAX-1288 candidates** are preserved verbatim in
`seed-candidate-profiles.json`; their 25 source records and review controls are
also retained. They are a different candidate set from the Google Sheet's
`C001`–`C016` factory ideas. All original IDs still occur in the 22 final decisions.
Rejected and merged candidates remain present rather than being silently deleted.

## What the six passes actually established

| Pass | Existing evidence and scope                                                                                                                                             | Remaining limit                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| P0   | Original package validator passed; all 11 original manifest hashes match. Source access and exclusions were recorded.                                                   | Original ZIP is unavailable; integrity is against the supplied manifest.                               |
| P1   | 22 candidates, including all 16 seeds and six additions.                                                                                                                | Broad coverage of every build or 8–12 archetypes was not achieved.                                     |
| P2   | Six complete public author PoBs, 21 planned item sets; three Animate Guardian sets excluded. Final decisions distinguish variants, acquired bases and finished targets. | Planned gear is not player prevalence, and a guide's patch label does not validate its complete build. |
| P3   | Two exploratory Week 1 UI cohorts of 20 characters each; four joint-property measurements were recomputed from the local individual observations.                       | Selected top Experience rows, not a representative sample. Calendar snapshot timestamps are unknown.   |
| P4   | Seven exact scoped chains with paid preparation/failure handling; all 22 candidates have terminal decisions. All 55 recipe evidence references exist locally.           | Conditional simulator generation proves reachability, not total spending or live-game execution.       |
| P5   | JSON/CSV, final decisions, market backlog and dated asking-price observations exist. Historical research-ledger repetitions were idempotent.                            | No completed sales, proven profit, production import or release acceptance.                            |

The four measured bundles are **11/20** RF helmets with both Burning Damage and
Concentrated Effect, **5/18** readable RF shields with recovery and flat life,
**1/20** Spectre helmets with minion levels and life, and **1/17** readable Spectre
shields with the corresponding pair. They describe only those selected cohorts.
RF support presence does not establish Fire Trap socket usage. These dated
observations do not establish purchases, current demand or another build variant.

## Exact handoff to the recipe catalog

`final-recipes.json` and `final-decisions.json` are verbatim source snapshots.
Their source paths, byte lengths and SHA-256 digests are in
`source-manifest.json`. Every recipe retains `financial_acceptance: false`;
every final decision retains `production_ready: false` and `profit: null`.
The later source registry and three final closure summaries are retained too;
they preserve the corrected base, build-scope and paid-recovery decisions.

| Accepted profile        | Scope that must survive handbook translation                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rf-fire-trap-helmet`   | Acquired Elder Archdemon Crown, actual ilvl 83; support pair plus AoE bench. Any-tier and 20/20 outputs are distinct. No life/resistance floor.                                                               |
| `lacerate-block-shield` | Acquired Shaper Pinnacle Tower Shield, natural ilvl 70; Greed life, recovery at least 4%, open suffix and resistance bench. Not the planned Synthesised endgame shield.                                       |
| `spectre-minion-helmet` | Ordinary Bone Helmet ilvl 75; Greed plus +2 minion levels and resistance bench. Accepted life can be below 100; not an exact Praetor or unique replacement.                                                   |
| `spectre-minion-shield` | Ordinary Fossilised Spirit Shield ilvl 60 with its native minion implicit; Greed, +1 minion levels and resistance bench. No Shaper recovery claim.                                                            |
| `spectre-fear-gloves`   | Acquired Leviathan Gauntlets ilvl 85 with fractured chaos resistance; paid Fear rerolls, life, Strength bench and lesser minion implicit. Acquiring the fracture is a priced input, not a free operation.     |
| `tr-aoe-helmet`         | Grizzly Pelt ilvl 85, life at least 100, suppression, useful elemental resistance, open prefix, exactly 10% crafted AoE and the documented Eldritch pair. Bench 8/9% outcomes require paid removal and retry. |
| `tr-plus3-bow`          | Qualified Hunter Thicket Bow ilvl 78; preparation, quality, six links, failed cleanup and the complete modifier chain have separate costs. Socket/link bench plan is data-backed, not executed in CoE.        |

No whole-chain expected consumption follows from an intermediate calculator
probability or a count of simulator actions. In particular, the bow's
100,000 actions are not 100,000 independent completed crafts. Missing base,
finishing, failure or expected-use evidence must leave expected total and ROI
unestimated. Listed prices from 2026-10-30 must not become fresh live quotes.

## Corrections to use when older notes disagree

- Use `checkpoint.json`, `final-decisions.json`, `final-recipes.json` and the
  final closure receipts for terminal scope. Earlier per-pass notes and the
  original `resume.md` preserve earlier partial states.
- The actual RF ilvl-83 tier-20 closure uses 910 reforges / 45,500 Wild Lifeforce;
  the older ilvl-82 833 / 41,650 numbers do not describe that input.
- Pinnacle ilvl 68 is rejected; the natural base floor used by the final chain
  is 70. Synthetic/imported states missing native implicits do not replace the
  qualified starting base.
- Final paid bow recovery records 162 actual failure Scours. Earlier notes
  describing 189 theoretical, unexecuted cleanup Scours are superseded.
- Fear's 34 and 35 fractured chaos inputs are distinct dated listings, and the
  lesser 14–16% minion implicit is not the planned 20–22% implicit.
- The old import README says 47 frozen files, but `run-1/2/3.json` and the frozen
  input contain **263**. Thirteen current files changed after that freeze;
  neither `final-recipes.json` nor `final-decisions.json` is included. The old
  repetitions prove the earlier research ledger's idempotence, not import of
  these final recipes. Current schema-v3 validation and database sync must
  establish the new import result.

## Verification and portability

`verification.json` records the local checks: source hash integrity, preservation
of all seed IDs, 7/1/14 decision parity, four recomputed fractions, 55 existing
recipe evidence references, frozen input integrity and historical repeat-run
digest equality. No research source file was changed. Existing raw market
payloads, player observations and full simulator archives were left in the
original local research directory.

`local-evidence-manifest.json` records each required raw recipe file's digest and
size under `research/build-demand/2026-10-30-manual`. Those files are **not included
in this Git bundle**. A clean checkout can inspect the scoped recipe definitions
and decisions but cannot reproduce every old simulator result without that
local archive. This is an explicit source portability gap.

Release work still needs the current recipe definitions/mappings validated and
synced twice against isolated staging, fresh permitted same-league quotes,
failure/restart and stale-price checks, browser acceptance and final runtime
review. Sales, realized profit, population demand and complete live-game build
equivalence remain unknown and must not be release claims.

Independent Claude Code source review completed successfully; its raw findings,
receipt and parent dispositions are included. It agrees with bounded research
completion and identifies three catalog translation risks: assigning RF support
observations to Fire Trap demand, promoting partial counts to total expected use,
and confusing starting-base conditions with finished-target filters.
