# Current exact Large Cluster models — 2026-11-03

Nine new recipes use the current public Craft of Exile 3.29.3.3 calculator.
All inputs are acquired rare, uninfluenced, unfractured, uncorrupted and
unsynthesised Large Clusters at exactly item level 68. Procurement and finished
comparables require exactly 8 passives, 2 jewel sockets and the stated small-passive
damage variant. All three named notables are required together in one AND group.

| Variant and full target                                          | Selected method | Displayed chance | Rounded material uses |
| ---------------------------------------------------------------- | --------------- | ---------------: | --------------------: |
| Bow: Arcing Shot / Martial Prowess / Vicious Skewering           | Chaos Orb       |         0.00677% |           14767 Chaos |
| Bow: Arcing Shot / Martial Prowess / Tempered Arrowheads         | Chaos Orb       |          0.0191% |            5223 Chaos |
| Cold: Sadist / Snowstorm / Widespread Destruction                | Prismatic       |          0.0391% |            2561 pairs |
| Shield attack: Fuel the Fight / Heavy Hitter / Veteran Defender  | Chaos Orb       |          0.0179% |            5586 Chaos |
| Chaos: Grim Oath / Touch of Cruelty / Wicked Pall                | Aberrant        |           0.243% |             412 pairs |
| Chaos: Touch of Cruelty / Unholy Grace / Wicked Pall             | Aberrant        |            1.31% |              77 pairs |
| Two handed: Brutal Infamy / Fuel the Fight / Smite the Weak      | Chaos Orb       |          0.0159% |            6296 Chaos |
| Two handed: Brutal Infamy / Feed the Fury / Smite the Weak       | Chaos Orb       |         0.00917% |           10907 Chaos |
| Fire: Prismatic Heart / Smoking Remains / Widespread Destruction | Prismatic       |           0.326% |             307 pairs |

One Chaos use consumes one ordinary Chaos Orb; one fossil pair consumes the
listed fossil plus one Primitive Chaotic Resonator. Expected base consumption is
one, with acquisition cost additional. Ordinary paid failed rerolls were observed
for every selected procedure; each missed the complete triple and retained its
family and item level. Repeat on the same rare base; no Scouring, Annul, bench or
base replacement is part of these single-stage methods.

The five Chaos procedures are expensive cost baselines, not profit recommendations.
Their probabilities and expected uses come exclusively from ordinary Chaos rerolls.
Serrated remains a comparison requiring fewer attempts, but its bulk cost for the
required quantity is unconfirmed. An observed top-of-book price does not establish
supply for hundreds of uses; the current Ninja feed omits Serrated. There is no
fabricated fossil price, automatic material substitution or mixed-method chance.
Whether Serrated is cheaper requires a separate sufficient-quantity quote.

The calculator header displays its unrolled 8–12 passive family range. The
notable-affix calculation uses the selected Large Cluster damage-family pool;
exactly 8 passives and 2 sockets are enforced as acquisition and market constraints,
not a separately rolled success condition. Notable positioning, additional
useful modifiers, quality and Intangibility are outside the target.

Original `cluster-<recipe-id>.json` receipts preserve the nine fossil observations,
requirement IDs, prefix/suffix origins, probability, paired mean and ordinary failed
rolls. All nine normalized fossil replay links were reopened in the current UI;
see `cluster-replay-validation.json`. The five selected Chaos procedures use
`cluster-chaos-<recipe-id>.json`, bound to the actual current UI observations in
`cluster-chaos-baselines.json`. The manifest points to the selected receipt and
retains the original Serrated receipt as a comparison. Replay URLs canonicalize
replaceable explicit mods to empty; the family, exact level and complete AND
requirements are identical across each fossil/Chaos comparison.

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

An independent public-file Claude Code review (24 turns) found no blockers.
Its caveats and dispositions are in `cluster-claude-review.json`. It did not
read private merchant history, write files or run the validator. The parent
agent ran the focused validator separately. This is not a formal GitHub approval.
