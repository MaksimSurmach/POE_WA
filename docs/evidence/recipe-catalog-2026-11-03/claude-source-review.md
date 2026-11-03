I checked everything read-only. **8 distinct finished outputs can be authored faithfully today, 9 recipe files at most.** That's below your 10–20 range, and the sources don't support more without padding. Every file must be `verification.status: "unverified"`, with `success`, `expectedExecutions` and `baseConsumption` left out.

**Source note:** `closure-recovery/results.json` doesn't exist. For the bow I used `closure-recovery/bow-recipe.json`, `README.md` and `bow-base-preparation/results.json`. Paths below are relative to `research/build-demand/2026-10-30-manual/` unless they are repo paths.

## 1. Ledger of the 16 starting candidates (`candidate_profiles.json`)

| Decision                      | Profiles                                                                                                                                                          | Source                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Accepted (7)                  | rf-fire-trap-helmet, lacerate-block-shield, spectre-minion-helmet, spectre-minion-shield, spectre-fear-gloves, tr-aoe-helmet, tr-plus3-bow                        | `final-decisions.json`, `final-recipes.json` |
| Merged (1)                    | srs-nonpoison-helmet → spectre-minion-helmet. Don't give it its own recipe; a tag at most.                                                                        | `final-decisions.json:192-208`               |
| Rejected (8)                  | lacerate-budget-belt, spectre-budget-belt, srs-recovery-shield, worb-es-implicit-gloves, worb-es-body, tr-basic-quiver, tr-hunter-quiver, worb-shaper-helmet-lead | `final-decisions.json`                       |
| Added later, all rejected (6) | rf-life-stacking-helmet, lacerate-as-gloves, tr-aoe-dot-gloves, tr-budget-belt, both Shrapnel items                                                               | same                                         |

Rejected variants of the accepted profiles must not be authored either:

- RF helmet: base at item level 82, elevated 25, socketed RF.
- Lacerate shield: Synthesised version.
- Bone helmet: 100-life floor, or an exact Praetor copy.
- TR helmet: the 12.3% calculator figure, Lion/Majestic bases.
- Gloves: synthetic 35 fracture, treating Warlock as equal to Leviathan, a 20–22 implicit.
- Bow: the Allflame route.

Sources: `closure-bases/results.json:391-421`, `bow-recipe.json:181-185`.

## 2. Outputs that can be authored

"Evidenced" means a range or threshold stated in the source. "Example" means a single observed roll — never use it as a threshold.

| #   | Output                                                            | Starting conditions                                              | Stages and paid recovery                                                                                                                                                                                              | Evidenced thresholds                                                                                                                                | Example values only                                   |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | RF Archdemon Crown, any support level                             | Rare, Elder only, ilvl 83, not fractured or corrupted            | Harvest Fire reforge (50 Wild each) until Conc + Burning + open prefix. Each failure is a full reforge on the same base. Then bench AoE / +1 AoE gems (4 Chaos).                                                      | Conc and Burning present at any level; bench 8–10% AoE + 1                                                                                          | 20/18, AoE 9                                          |
| 2   | RF Archdemon Crown, 20/20 (source treats it as a separate target) | same                                                             | same                                                                                                                                                                                                                  | Both supports level 20 (CoE tier 1, `rf83-tier20-calculator-url.txt`)                                                                               | AoE 8                                                 |
| 3   | Lacerate Pinnacle Tower Shield                                    | Shaper only, ilvl 70, bought base (price not measured)           | Deafening Greed until recovery 4–5% + open suffix. A 3% roll is rejected and Greed repeated. Optional paid Scour. Then bench resistance 29–35 (3 Chaos).                                                              | Recovery ≥ 4; Greed life 130–144; bench resistance 29–35                                                                                            | 139 / 21 / 5 / 33 fire / 900 armour                   |
| 4   | Spectre Bone Helmet                                               | ilvl 75, uninfluenced                                            | Greed until +2 minion gems + open suffix. Repeat Greed, or Scour. Then bench resistance (3 Chaos).                                                                                                                    | +2 minion gems; Greed life 91–105; **no 100-life floor**                                                                                            | 92 life, 18 implicit                                  |
| 5   | Spectre Fossilised Spirit Shield                                  | ilvl 60, uninfluenced                                            | Greed until +1 minion gems + open suffix. Repeat Greed, no Scour needed. Then bench resistance.                                                                                                                       | +1 minion gems; resistance 29–35. **No life range is stated in the source.**                                                                        | 136 life, 6 implicit                                  |
| 6   | TR Grizzly Pelt                                                   | ilvl 85, uninfluenced                                            | Greed until life ≥ 100 + suppression + one elemental resistance + open prefix (Scour optional). Bench AoE (4 Chaos); an 8 or 9 roll means bench removal (1 Scour) and re-craft. Then Lesser Ember, then Lesser Ichor. | Life ≥ 100; suppression present; crafted AoE exactly 10 with +1 AoE gems; unconditional Mana Cost Efficiency; physical hits taken as Lightning      | 102 life, 8 suppression, 21 cold, 26 MCE, 6 lightning |
| 7   | Spectre Leviathan Gauntlets                                       | Rare, ilvl 85, **fractured chaos resistance 34** (dated listing) | Deafening Fear until life tier 2+ and open suffix. Repeat Fear; optional paid Scour then Regal. Bench Strength 26–30 (2 Chaos). Then Lesser Ember.                                                                    | Life ≥ 100 (100–129); Strength 26–30; minion damage implicit 14–16                                                                                  | 115 life, 29 Fear minion damage, 15 implicit          |
| 8   | TR Thicket Bow                                                    | Normal, Hunter, ilvl 78, quality 20, 6-linked                    | Steps 1–12 in `final-recipes.json:356-464`. Every failure is a paid Scour (step 12).                                                                                                                                  | Attack speed ≥ 17 (tier 1); +1 socketed gems; Hunter chaos DoT ≥ 80 (tier 2+); crafted +2 support gems; crafted chaos DoT multiplier ≥ 18; multimod | 18 / 88 / 18                                          |

**Optional 9th recipe file:** the bow from a natural uninfluenced Thicket 78. Preparation was 20 Whetstones, Alchemy, conditional Annul, Hunter's Exalted, Scour. It ran once (`bow-base-preparation/results.json`). The source treats this and buying a ready Hunter base as mutually exclusive, so it's a second method for the same output.

**Not authorable:**

- Warlock 34/35 gloves: kept separate and not accepted (`closure-bases/results.json:330-352`).
- Self-fracture route: 0 of 3 attempts succeeded.

## 3. Probabilities and counts — leave them all out

- **Calculator figures that match a single stage exactly:**
  - RF any: 1.07% / 94
  - RF 20/20: 0.11% / 910
  - Bone helmet: 0.0683% / 1465
  - Fossilised shield: 0.711% / 141
  - Gloves Fear core: 2.9% / 35

  Even these can't be used: the artifacts don't record the CoE data version (`rf83-any-calculator.dom.txt` has none), and `recipeSchema.ts:214` requires `evidence.patch === recipe.patch`.

- **Never usable:**
  - Lacerate 1.44% measures 3–5% recovery, not 4–5 (`closure-bases/results.json:116`).
  - TR helmet 12.3% leaves out the life and resistance conditions (`:270`).
  - Old item-level-82 numbers 833/41650.
  - Bow 100k-run counts: the source itself says they are not probabilities (`closure-recovery/README.md:41`).
- **Status:** `production_ready` and `financial_acceptance` are false everywhere. The existing cluster recipes are marked `verified` — don't copy that.

## 4. Likely translation mistakes against the current code

**Mod IDs and kinds**

1. `resolveTarget` ignores `condition.kind` (`apps/server/src/tradeMappings.ts:182-185`). The same stat as implicit and explicit needs two canonical modIds, one mapped to `implicit.stat_X` and one to `explicit.stat_X`. Affected: gloves minion damage (Fear explicit vs Ember implicit), native life, minion damage implicits.
2. There is no `crafted` kind, and prefixes/suffixes only accept `explicit` or `fractured` (`recipeSchema.ts:187-192`). Bench mods are `crafted.stat_*` on Trade, so labelling them `explicit` gives a wrong query. Affected: AoE / +1 AoE, resistance, Strength, +2 support, chaos multiplier, multimod. You need a schema decision, or leave bench mods out of `target` and document them in steps.
3. Hybrid mods. Elder Conc is a **prefix** (`AreaDamageSupportedUber3`); Elder Burning is a **suffix** (`IncreasedBurningDamageSupportedUber2`) (`rf83-any-calculator.dom.txt:108-117`, `rf83-any-calculator-url.txt`). The bench AoE mod is `JunMaster2SkillAreaOfEffectPercentAndAreaOfEffectGemLevel1`. For 20/20, filter on the support-level stat, not the % damage stat.
4. Tier direction is ambiguous. Game-data keys count upward (`ChaosResist6` is the best tier); the CoE UI uses tier 1 = best. Prefer `minimumValue` over tiers.
5. `mapping.minimum ?? condition.minimumValue` (`packages/domain/src/trade.ts:289`) means a mapping-level minimum silently overrides the recipe's value.
6. Not mapped anywhere: suppression, Mana Cost Efficiency, physical taken as Lightning, +1 socketed gems, +2 support, local attack speed, Hunter chaos DoT, chaos DoT multiplier, multimod. `tradeStatMappings.ts` has only some of the needed stats. It is a display table taken from Awakened PoE Trade, not the query mappings, so its IDs still need validation by `loadAndValidateTradeMappingManifest`.

**Implicit state and influences**

7. Native implicits are implied by `baseId` and should not go in `target.implicits`: Archdemon +2/-2, Pinnacle life, Bone/Fossilised minion damage. Eldritch implicits are not influences: TR helmet and gloves use `influences: []`, with Ember/Ichor results in `target.implicits`.
8. The Trade query has no influence or fractured filter (`trade.ts:150-169`). Those are only post-filtered via `handbookTarget` (`recipeMarket.ts:163-173`). Elder, Shaper and Hunter searches can return a cheapest page with no matching items.
9. `startingMods` has only `modId` and `tier`, and the code forces kind `explicit` (`craftMethod.ts:30-33`, `recipeMarket.ts:133-138`). The 34 vs 35 fracture distinction can't be expressed, so the base price will mix 31–35 fractures.
10. `startingBase` can't express quality 20, 6 sockets/links, unmirrored, "normal or rare", or exact ilvl 78 (the query uses ilvl as a minimum, `trade.ts:156`). The bow's starting price will be wrong unless these go in notes as unpriced procurement conditions.
11. "One elemental resistance" (TR helmet) and "compatible resistance" (Greed items) are any-of conditions, but `anyOf` is forced empty (`recipeSchema.ts:164-168`). Don't hard-code fire or cold from the examples.

**Base and material IDs**

12. Base IDs confirmed from CoE exports:
    - Archdemon Crown: `Metadata/Items/Armours/Helmets/HelmetStrIntRitual3`
    - Fossilised Spirit Shield: `…/Shields/ShieldInt13`
    - Leviathan Gauntlets: `…/Gloves/GlovesStr11`
    - Thicket Bow: `Metadata/Items/Weapons/TwoHandWeapons/Bows/Bow16`

    **Not found:** Bone Helmet, Pinnacle Tower Shield, Grizzly Pelt. `base-source.json` and the mapping manifest only contain Large Cluster Jewel, so every new base needs a game-data record and a Trade base mapping. CoE influence codes seen: Elder = 1, Hunter = 4. There is no canonical influence-ID convention in the repo yet.

13. Material IDs:
    - Mapped with an exchange ID: only `orb-of-alteration` (`alt`) and `orb-of-transmutation` (`transmute`).
    - Ninja line IDs `wild-lifeforce` and `chaos` appear only in the old `catalog/rf-allflame-scenario-2026-11-02.json:284,297`.
    - Unverified, check against the Trade static data first: Greed, Fear and Envy essences, Scour, Regal, Annul, Exalted, Divine, Lesser Ember/Ichor, Whetstone, Alchemy, Hunter's Exalted, Jeweller's, Fusing, Fracturing Orb.
    - Per-use quantities are in §2 and `bow-base-preparation/results.json:68-90`.

**Other**

14. `verification.sources` must be URLs. Local research paths go in `notes` or `evidence.artifact`. Leaving `leagues` empty withholds evaluation; no source validates a specific league.
15. Generate `targetSignature` with `recipeTargetSignature` / `pnpm recipes:validate`. Don't write it by hand.
16. **TR helmet source conflict:** `closure-bases/results.json:248` treats exact 10 as optional, but `final-recipes.json:229` makes it the benchmark. The 8/9 → remove and re-craft branch was executed on the bow, not on the helmet. Record that as an uncertainty.
