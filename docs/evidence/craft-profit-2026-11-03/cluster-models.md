# Current exact Large Cluster models — 2026-11-03

Nine new recipes use the current public Craft of Exile 3.29.3.3 calculator.
All inputs are acquired rare, uninfluenced, unfractured, uncorrupted and
unsynthesised Large Clusters at exactly item level 68. Procurement and finished
comparables require exactly 8 passives, 2 jewel sockets and the stated small-passive
damage variant. All three named notables are required together in one AND group.

| Variant and full target                                          | Single fossil | Displayed chance | Rounded paired uses |
| ---------------------------------------------------------------- | ------------- | ---------------: | ------------------: |
| Bow: Arcing Shot / Martial Prowess / Vicious Skewering           | Serrated      |           0.117% |                 857 |
| Bow: Arcing Shot / Martial Prowess / Tempered Arrowheads         | Serrated      |           0.331% |                 303 |
| Cold: Sadist / Snowstorm / Widespread Destruction                | Prismatic     |          0.0391% |                2561 |
| Shield attack: Fuel the Fight / Heavy Hitter / Veteran Defender  | Serrated      |          0.0423% |                2363 |
| Chaos: Grim Oath / Touch of Cruelty / Wicked Pall                | Aberrant      |           0.243% |                 412 |
| Chaos: Touch of Cruelty / Unholy Grace / Wicked Pall             | Aberrant      |            1.31% |                  77 |
| Two handed: Brutal Infamy / Fuel the Fight / Smite the Weak      | Serrated      |           0.327% |                 306 |
| Two handed: Brutal Infamy / Feed the Fury / Smite the Weak       | Serrated      |           0.151% |                 661 |
| Fire: Prismatic Heart / Smoking Remains / Widespread Destruction | Prismatic     |           0.326% |                 307 |

Every use consumes one listed fossil and one Primitive Chaotic Resonator.
Expected base consumption is one. Ordinary paid failed rerolls were observed
for all nine targets; each missed the complete triple and retained its family
and item level. Repeat on the same rare base; no Scouring, Annul, bench or base
replacement is part of these single-stage methods.

The calculator header displays its unrolled 8–12 passive family range. The
notable-affix calculation uses the selected Large Cluster damage-family pool;
exactly 8 passives and 2 sockets are enforced as acquisition and market constraints,
not a separately rolled success condition. Notable positioning, additional
useful modifiers, quality and Intangibility are outside the target.

Each `cluster-<recipe-id>.json` receipt stores observed current requirement IDs,
prefix/suffix origins, displayed probability and paired mean, and the ordinary
failed-roll notables. Replay URLs canonicalize replaceable starting explicit
mods to empty; a chaotic fossil replaces those modifiers. The normalized cold
Prismatic link was reopened in the current UI and reproduced 0.0391% / 2561.

The two alternative checks in `cluster-route-comparisons.json` show why a
same-element fossil is not automatically best: cold Frigid gave 41568 paired uses
and fire Scorched 4181, versus selected Prismatic 2561 and 307. This is a bounded
method comparison, not proof of global cost optimality. Current asking prices
must be collected independently; no CoE default prices or personal transaction
prices appear in the expected-cost model.

Run the focused public evidence binding check from the repository root after
the domain package is built:

```sh
node docs/evidence/craft-profit-2026-11-03/cluster-validation.mjs
```

Scope: indicative analytical expectations only. No empirical completed-item
sample, in-game trade, positive ROI or particular notable layout is established.
The optional bow simulation was stopped before a full success and is not used
as expected-consumption evidence.
