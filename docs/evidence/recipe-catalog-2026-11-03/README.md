# Source recipe catalog — 2026-11-03

The handbook contains 15 JSON recipes: two existing checked physical cluster
methods, ten newly checked methods and three new
**unverified** exact targets. All rows can collect comparable asking prices and
material unit prices. The three unverified methods have no invented expected
executions/base consumption and withhold full expected craft cost and ROI.

Current public CoE3.29.3.3 checked on2026-11-03 gives rounded mean15Zeal uses
(6.8%) or22Fear uses(4.57%) for acquired rareDragonscale85 with fractured14%
suppression and lifeT2+100–129. Zeal guarantees17–18%attack speed; Fear
guarantees28–30%minion damage as a prefix. Exact calculator URLs, complete
successful outcomes and ordinary paid failure rerolls are archived in
`coe-suppression-zeal.json` and `coe-suppression-fear.json`. These are indicative
calculator expectations on one reusable acquired base, not empirical spending
or completed sales. Scope is currentlyAllflame only. The currency identity 1 Chaos Orb = 1 chaos prices fixed bench
fees without requesting an invalid chaos-to-chaos exchange.

## Sources and scope

- `source-sheet.json` preserves the read-only `Крафты!A1:Z65` capture with all
  C001–C016. Its div ranges, liquidity labels and build demand are source
  assumptions, never live quotes.
- `source-formulas.json` preserves formulas for rows C006–C009. Some cells begin
  `=+` and display `#ERROR!`. `candidate-projection.json` retains the raw error
  and separately records the recovered source text. The original Sheet was not
  edited. All 16 candidates remain; unsupported broad lines are retained as leads.
- `../research-acceptance-2026-11-03/final-recipes.json` preserves the seven scoped
  MAX-1288 procedures. The old rejected build-fit belts are not reinstated by the
  generic Sheet-derived Stygian SKUs. The Hunter bow stays outside the live JSON
  catalog: the current item contract cannot enforce its six-link/quality inputs.
- `trade-identities.json` contains selected public Trade items/stats/static
  metadata checked on this date. It proves identity, not affix weights or craft
  success. `base:` IDs are explicit local mapping keys where the metadata path
  was not established; they do not claim an upstream game metadata identifier.
- `claude-source-review.md` and its receipt record an actual independent Claude
  Code source pass. Findings were considered, not treated as formal GitHub approval.

New recipes: two Elder Fire Trap helmet targets, Shaper recovery shield, Bone
minion helmet, Fossilised minion shield, Grizzly AoE helmet, fractured-chaos minion
gloves, two Stygian methods/targets, two suppression glove lines, suppression
avoidance boots and +2 Convoking Wand. Elemental/other thresholds selected for a
concrete SKU are not universal guide minima. TR's cold21/suppression8/efficiency26/
lightning6 are explicit selected numeric finish constraints derived from its
saved example; they are stricter than the broad research procedure and require
another paid reroll if missing. Its AoE recovery branch was demonstrated on the
bow, not independently re-executed on the helmet. Native implicit floors only
narrow the declared base identity; they do not add a crafting operation.

No in-game purchases, crafting, completed sales, whole-build equivalence, optimum
method or profitability are established. The ten new models cover both suppression-glove lines, Loathing boots, two
Stygian lines, the +2 wand, two RF support/AoE lines and the Bone/Fossilised
Greed chains.
Optional implicit, catalyst and trigger finishes from broader Sheet leads are
outside the verified models. Only the explicitly documented bench finishes are included.

## Import and run

Back up an existing database; use forward migrations and retain its history.
Run these from the repository root with the intended database environment:

```sh
pnpm build
pnpm recipes:validate
pnpm game-data:import apps/server/mappings/poe-trade/3.29.3.3/base-source.json
pnpm game-data:activate <version-id-printed-by-import>
pnpm trade-mappings:import apps/server/mappings/poe-trade/3.29.3.3/physical-large-cluster.json
pnpm trade-mappings:import apps/server/mappings/poe-trade/3.29.3.3/recipe-catalog.json
pnpm recipes:sync --dry-run
pnpm recipes:sync
pnpm start
```

An expanded same-patch game-data version archives the previous version. Both
mapping manifests must then be imported onto the active version. Lookups now
exclude archived versions; their rows are retained. Recipe sync preserves the
two existing IDs, adds 13 and never deletes observations or historical snapshots.
Use **Refresh Prices** with permitted collection access. A challenge/403 remains
an access blocker; source captures must not be replayed as fresh observations.

## Checks

- Canonical JSON validation, deterministic content hashes and idempotent in-memory
  sync of all 15; all 16 source candidates retained.
- Current official public items/stats validated the new mapping manifest (52 IDs).
- Every current recipe's base/target/material resolves; presentation labels are
  readable. Three new recipes have no full expected-cost model; ten scoped methods
  have bounded current CoE evidence. Product tags contain game concepts only;
  provenance IDs stay in source evidence.
- Regression: a fractured suppression roll matches; the same numeric ordinary
  suppression on a different fracture cannot match.
- Regression: exact fractured starting origin/value reaches the search and
  post-filter; malformed ranges reject. Chaos fees use exact currency units.
- PostgreSQL same-patch mapping replacement regression is included for the
  release test database; live staging is owned by the parent release pass.

Additional current CoE3.29.3.3 whole single-stage means checked2026-11-03:
Envy Stygian613essences, Pristine+Prismatic Stygian942sets (two fossils and one
Potent Chaotic Resonator per set), +2 Convoking12sets (four fossils and one Prime
Chaotic Resonator per set). All exact requirements, paid failures and complete
outputs are in `coe-stygian-envy.json`, `coe-stygian-fossils.json` and
`coe-convoking-wand.json`. These three definitions change no existing target query.

CurrentLoathing boot core:12essences,8.44%, nativeMovementT3+25 with acquired
14suppressionfracture and guaranteed31–35avoidance. No life floor or repair is
modelled. CurrentRFwholechain:94or910joint supports+open-prefix reforges (50Wild
each), then exactlyone4ChaosAoEbench acceptingany8–10roll; no hidden finish
retry. Actualpaidfinishes observed16/16supports+10AoE/+1 and20/20+8AoE/+1.

The October30rawresearch RFURLs use IDs2839/2844, which now point to other
modifiers. Those historical archives remain unchanged. NewRFmodels were rebuilt
from currentUIIDs2840/2845 plusmandatoryOpenPrefix>=1. Existing activeNovember2
legacycatalog URLs were checked and already use thosecorrectIDs. C011Sheet
Horror/Burning/life remains a separate lead; these checkedMAX-1288FireTrap
support-pair routes are related alternatives, not satisfaction of its fulltarget.

Current minion Greed chains include the exact stopping rule: required gem levels,
at least one open suffix, and no native Fire Resistance. Bone Helmet level 75
gives 0.0525% / 1907 rounded essences and guarantees 91–105 life. Fossilised
Shield level 60 gives 0.594% / 169 and guarantees 130–144 life. Native minion
implicit ranges are preserved. Both require exactly one 29–35% Fire Resistance
bench for 3 Chaos Orbs; paid finishes rolled 30% Fire Resistance on complete
cores. The older 1465/141 means omit the no-fire condition and are not reused.
These estimates remain indicative; low-budget names identify a build stage,
not cheap crafting.

Starting-base collection now enforces exactly the authored item level in both
Trade search requests and local matching. Higher levels can add affix tiers and
require another cost model. Finished-item comparables still accept higher levels.
The Buy Base URL carries the same exact input restriction. `maxItemLevel` is an
optional target field and requires no database migration.

Upgrade: stop the previous broad-base cycle, synchronize all 15 updated recipes,
and run a fresh cycle. Their explicit acquisition uncertainties change every
recipe content hash, so older expected costs are hidden by existing read guards;
historical evaluations and snapshots are retained. Completed finished-target and
material observations remain reusable by their unchanged query hashes. Starting
queries change and must be collected again. `exact-level-query-proof.json`
records before/after production hashes against8dda1c3 for all15 recipes: every
finished hash is unchanged and every starting hash changes.
