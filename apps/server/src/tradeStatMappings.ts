// Stat IDs from Awakened PoE Trade, MIT; revision 3188208957422b21b69b12083a03edf3d1bac187.
// https://github.com/SnosMe/awakened-poe-trade/blob/3188208957422b21b69b12083a03edf3d1bac187/renderer/public/data/en/stats.ndjson
export const tradeMappingVersion = 'awakened-318820895742';
export const tradeStatMappings: Record<
  string,
  { key: string; text: string; negativeText?: string }
> = {
  'explicit.stat_3182498570': {
    key: 'flask_movement_speed',
    text: '#% increased Movement Speed during Effect',
  },
  'explicit.stat_2448920197': {
    key: 'flask_effect',
    text: '#% increased effect',
    negativeText: '#% reduced effect',
  },
  'explicit.stat_1256719186': {
    key: 'flask_duration',
    text: '#% increased Duration',
    negativeText: '#% reduced Duration',
  },
  'enchant.stat_2448920197': {
    key: 'flask_enchant_effect',
    text: '#% increased effect',
  },
  'pseudo.pseudo_increased_elemental_damage_with_attack_skills': {
    key: 'elemental_attack_damage',
    text: '#% increased Elemental Damage with Attack Skills',
  },
  'explicit.stat_387439868': {
    key: 'elemental_attack_damage',
    text: '#% increased Elemental Damage with Attack Skills',
  },
  'implicit.stat_387439868': {
    key: 'elemental_attack_damage',
    text: '#% increased Elemental Damage with Attack Skills',
  },
  'fractured.stat_387439868': {
    key: 'elemental_attack_damage',
    text: '#% increased Elemental Damage with Attack Skills',
  },
  'crafted.stat_387439868': {
    key: 'elemental_attack_damage',
    text: '#% increased Elemental Damage with Attack Skills',
  },
  'explicit.stat_3261801346': {
    key: 'dexterity',
    text: '+# to Dexterity',
  },
  'implicit.stat_3261801346': {
    key: 'dexterity',
    text: '+# to Dexterity',
  },
  'fractured.stat_3261801346': {
    key: 'dexterity',
    text: '+# to Dexterity',
  },
  'crafted.stat_3261801346': {
    key: 'dexterity',
    text: '+# to Dexterity',
  },
  'explicit.stat_2162097452': {
    key: 'minion_gem_level',
    text: '+# to Level of all Minion Skill Gems',
  },
  'implicit.stat_2162097452': {
    key: 'minion_gem_level',
    text: '+# to Level of all Minion Skill Gems',
  },
  'fractured.stat_2162097452': {
    key: 'minion_gem_level',
    text: '+# to Level of all Minion Skill Gems',
  },
  'explicit.stat_2551600084': {
    key: 'socketed_aoe_level',
    text: '+# to Level of Socketed AoE Gems',
  },
  'implicit.stat_2551600084': {
    key: 'socketed_aoe_level',
    text: '+# to Level of Socketed AoE Gems',
  },
  'fractured.stat_2551600084': {
    key: 'socketed_aoe_level',
    text: '+# to Level of Socketed AoE Gems',
  },
  'crafted.stat_2551600084': {
    key: 'socketed_aoe_level',
    text: '+# to Level of Socketed AoE Gems',
  },
  'explicit.stat_3299347043': {
    key: 'life',
    text: '+# to maximum Life',
  },
  'implicit.stat_3299347043': {
    key: 'life',
    text: '+# to maximum Life',
  },
  'fractured.stat_3299347043': {
    key: 'life',
    text: '+# to maximum Life',
  },
  'crafted.stat_3299347043': {
    key: 'life',
    text: '+# to maximum Life',
  },
  'explicit.stat_4080418644': {
    key: 'strength',
    text: '+# to Strength',
  },
  'implicit.stat_4080418644': {
    key: 'strength',
    text: '+# to Strength',
  },
  'fractured.stat_4080418644': {
    key: 'strength',
    text: '+# to Strength',
  },
  'crafted.stat_4080418644': {
    key: 'strength',
    text: '+# to Strength',
  },
  'explicit.stat_2923486259': {
    key: 'chaos_resistance',
    text: '+#% to Chaos Resistance',
  },
  'implicit.stat_2923486259': {
    key: 'chaos_resistance',
    text: '+#% to Chaos Resistance',
  },
  'fractured.stat_2923486259': {
    key: 'chaos_resistance',
    text: '+#% to Chaos Resistance',
  },
  'explicit.stat_4220027924': {
    key: 'cold_resistance',
    text: '+#% to Cold Resistance',
  },
  'implicit.stat_4220027924': {
    key: 'cold_resistance',
    text: '+#% to Cold Resistance',
  },
  'fractured.stat_4220027924': {
    key: 'cold_resistance',
    text: '+#% to Cold Resistance',
  },
  'crafted.stat_4220027924': {
    key: 'cold_resistance',
    text: '+#% to Cold Resistance',
  },
  'explicit.stat_3372524247': {
    key: 'fire_resistance',
    text: '+#% to Fire Resistance',
  },
  'implicit.stat_3372524247': {
    key: 'fire_resistance',
    text: '+#% to Fire Resistance',
  },
  'fractured.stat_3372524247': {
    key: 'fire_resistance',
    text: '+#% to Fire Resistance',
  },
  'crafted.stat_3372524247': {
    key: 'fire_resistance',
    text: '+#% to Fire Resistance',
  },
  'explicit.stat_1671376347': {
    key: 'lightning_resistance',
    text: '+#% to Lightning Resistance',
  },
  'implicit.stat_1671376347': {
    key: 'lightning_resistance',
    text: '+#% to Lightning Resistance',
  },
  'fractured.stat_1671376347': {
    key: 'lightning_resistance',
    text: '+#% to Lightning Resistance',
  },
  'crafted.stat_1671376347': {
    key: 'lightning_resistance',
    text: '+#% to Lightning Resistance',
  },
  'pseudo.pseudo_total_elemental_resistance': {
    key: 'total_elemental_resistance',
    text: '+#% total Elemental Resistance',
  },
  'explicit.stat_2442647190': {
    key: 'life_on_block',
    text: 'Recover #% of Life when you Block',
  },
  'implicit.stat_2442647190': {
    key: 'life_on_block',
    text: 'Recover #% of Life when you Block',
  },
  'fractured.stat_2442647190': {
    key: 'life_on_block',
    text: 'Recover #% of Life when you Block',
  },
  'explicit.stat_2680613507': {
    key: 'burning_support',
    text: 'Socketed Gems are Supported by Level # Burning Damage',
  },
  'fractured.stat_2680613507': {
    key: 'burning_support',
    text: 'Socketed Gems are Supported by Level # Burning Damage',
  },
  'explicit.stat_2388360415': {
    key: 'concentrated_support',
    text: 'Socketed Gems are Supported by Level # Concentrated Effect',
  },
  'implicit.stat_2388360415': {
    key: 'concentrated_support',
    text: 'Socketed Gems are Supported by Level # Concentrated Effect',
  },
  'fractured.stat_2388360415': {
    key: 'concentrated_support',
    text: 'Socketed Gems are Supported by Level # Concentrated Effect',
  },
  'explicit.stat_280731498': {
    key: 'area_of_effect',
    text: '#% increased Area of Effect',
  },
  'implicit.stat_280731498': {
    key: 'area_of_effect',
    text: '#% increased Area of Effect',
  },
  'fractured.stat_280731498': {
    key: 'area_of_effect',
    text: '#% increased Area of Effect',
  },
  'crafted.stat_280731498': {
    key: 'area_of_effect',
    text: '#% increased Area of Effect',
  },
  'explicit.stat_1589917703': {
    key: 'minion_damage',
    text: 'Minions deal #% increased Damage',
  },
  'implicit.stat_1589917703': {
    key: 'minion_damage',
    text: 'Minions deal #% increased Damage',
  },
  'fractured.stat_1589917703': {
    key: 'minion_damage',
    text: 'Minions deal #% increased Damage',
  },
  'crafted.stat_1589917703': {
    key: 'minion_damage',
    text: 'Minions deal #% increased Damage',
  },
};

// Cluster query IDs are also validated by mappings/poe-trade/3.29.3.3/physical-large-cluster.json.
Object.assign(tradeStatMappings, {
  'explicit.stat_4188581520': {
    key: 'battle-hardened',
    text: '1 Added Passive Skill is Battle-Hardened',
  },
  'explicit.stat_3415827027': {
    key: 'furious-assault',
    text: '1 Added Passive Skill is Furious Assault',
  },
  'explicit.stat_3585232432': {
    key: 'master-the-fundamentals',
    text: '1 Added Passive Skill is Master the Fundamentals',
  },
  'enchant.stat_3086156145': {
    key: 'passive-count',
    text: 'Adds # Passive Skills',
  },
  'enchant.stat_3948993189|12': {
    key: 'physical-small-passives',
    text: 'Added Small Passive Skills grant: 12% increased Physical Damage',
  },
  'enchant.stat_4079888060': {
    key: 'jewel-sockets',
    text: '# Added Passive Skills are Jewel Sockets',
  },
});

// Current public Trade metadata checked 2026-11-03; exact origins remain separate.
// Identity receipts: docs/evidence/recipe-catalog-2026-11-03/trade-identities.json.
Object.assign(tradeStatMappings, {
  'explicit.stat_3680664274': {
    key: 'mod:suppression',
    text: '+#% chance to Suppress Spell Damage',
  },
  'fractured.stat_3680664274': {
    key: 'mod:fractured-suppression',
    text: '+#% chance to Suppress Spell Damage',
  },
  'explicit.stat_681332047': {
    key: 'mod:attack-speed',
    text: '#% increased Attack Speed',
  },
  'explicit.stat_3005472710': {
    key: 'mod:ailment-avoidance',
    text: '#% chance to Avoid Elemental Ailments',
  },
  'explicit.stat_2250533757': {
    key: 'mod:movement-speed',
    text: '#% increased Movement Speed',
  },
  'explicit.stat_124131830': {
    key: 'mod:spell-gems',
    text: '+# to Level of all Spell Skill Gems',
  },
  'implicit.stat_4101445926': {
    key: 'mod:mana-efficiency',
    text: '#% increased Mana Cost Efficiency',
  },
  'implicit.stat_425242359': {
    key: 'mod:physical-as-lightning',
    text: '#% of Physical Damage from Hits taken as Lightning Damage',
  },
  'explicit.stat_2843100721': {
    key: 'mod:socketed-gems',
    text: '+# to Level of Socketed Gems',
  },
  'crafted.stat_4154259475': {
    key: 'mod:support-gems',
    text: '+# to Level of Socketed Support Gems',
  },
  'crafted.stat_4055307827': {
    key: 'mod:chaos-dot-multiplier',
    text: '+#% to Chaos Damage over Time Multiplier',
  },
});

// Exact public Trade identities for craft-profit catalog, checked 2026-11-03.
Object.assign(tradeStatMappings, {
  'enchant.stat_3948993189|4': {
    key: 'bow-damage',
    text: 'Added Small Passive Skills grant: 12% increased Damage with Bows\nAdded Small Passive Skills grant: 12% increased Damage Over Time with Bow Skills',
  },
  'enchant.stat_3948993189|15': {
    key: 'cold-damage',
    text: 'Added Small Passive Skills grant: 12% increased Cold Damage',
  },
  'enchant.stat_3948993189|8': {
    key: 'shield-attack-damage',
    text: 'Added Small Passive Skills grant: 12% increased Attack Damage while holding a Shield',
  },
  'enchant.stat_3948993189|16': {
    key: 'chaos-damage',
    text: 'Added Small Passive Skills grant: 12% increased Chaos Damage',
  },
  'enchant.stat_3948993189|6': {
    key: 'two-handed-damage',
    text: 'Added Small Passive Skills grant: 12% increased Damage with Two Handed Weapons',
  },
  'enchant.stat_3948993189|13': {
    key: 'fire-damage',
    text: 'Added Small Passive Skills grant: 12% increased Fire Damage',
  },
  'explicit.stat_3212859169': {
    key: 'mod:arcing-shot',
    text: '1 Added Passive Skill is Arcing Shot',
  },
  'explicit.stat_1152182658': {
    key: 'mod:martial-prowess',
    text: '1 Added Passive Skill is Martial Prowess',
  },
  'explicit.stat_567971948': {
    key: 'mod:vicious-skewering',
    text: '1 Added Passive Skill is Vicious Skewering',
  },
  'explicit.stat_2631806437': {
    key: 'mod:tempered-arrowheads',
    text: '1 Added Passive Skill is Tempered Arrowheads',
  },
  'explicit.stat_3638731729': {
    key: 'mod:sadist',
    text: '1 Added Passive Skill is Sadist',
  },
  'explicit.stat_1595367309': {
    key: 'mod:snowstorm',
    text: '1 Added Passive Skill is Snowstorm',
  },
  'explicit.stat_1678643716': {
    key: 'mod:widespread-destruction',
    text: '1 Added Passive Skill is Widespread Destruction',
  },
  'explicit.stat_3599340381': {
    key: 'mod:fuel-the-fight',
    text: '1 Added Passive Skill is Fuel the Fight',
  },
  'explicit.stat_3640252904': {
    key: 'mod:heavy-hitter',
    text: '1 Added Passive Skill is Heavy Hitter',
  },
  'explicit.stat_664010431': {
    key: 'mod:veteran-defender',
    text: '1 Added Passive Skill is Veteran Defender',
  },
  'explicit.stat_2194205899': {
    key: 'mod:grim-oath',
    text: '1 Added Passive Skill is Grim Oath',
  },
  'explicit.stat_2780712583': {
    key: 'mod:touch-of-cruelty',
    text: '1 Added Passive Skill is Touch of Cruelty',
  },
  'explicit.stat_1616734644': {
    key: 'mod:wicked-pall',
    text: '1 Added Passive Skill is Wicked Pall',
  },
  'explicit.stat_2068574831': {
    key: 'mod:brutal-infamy',
    text: '1 Added Passive Skill is Brutal Infamy',
  },
  'explicit.stat_540300548': {
    key: 'mod:smite-the-weak',
    text: '1 Added Passive Skill is Smite the Weak',
  },
  'explicit.stat_2342448236': {
    key: 'mod:prismatic-heart',
    text: '1 Added Passive Skill is Prismatic Heart',
  },
  'explicit.stat_2322980282': {
    key: 'mod:smoking-remains',
    text: '1 Added Passive Skill is Smoking Remains',
  },
  'explicit.stat_4186213466': {
    key: 'mod:unholy-grace',
    text: '1 Added Passive Skill is Unholy Grace',
  },
  'explicit.stat_3944525413': {
    key: 'mod:feed-the-fury',
    text: '1 Added Passive Skill is Feed the Fury',
  },
  'fractured.stat_3091578504': {
    key: 'mod:fractured-minion-attack-cast-speed',
    text: 'Minions have #% increased Attack and Cast Speed',
  },
  'crafted.stat_3079007202': {
    key: 'mod:crafted-trigger-8s',
    text: '#% chance to Trigger a Socketed Spell on Using a Skill, with a 8 second Cooldown\nSpells Triggered this way have 150% more Cost',
  },
  'armour.es': {
    key: 'item-energy-shield',
    text: 'Item Energy Shield',
  },
  'socket.links': {
    key: 'socket-links',
    text: 'Linked Sockets',
  },
  'misc.quality': {
    key: 'item-quality',
    text: 'Item Quality',
  },
});

Object.assign(tradeStatMappings, {
  'misc.base_defence_percentile': {
    key: 'base-defence-percentile',
    text: 'Base Defence Percentile',
  },
});

// Local is a Trade-dropdown qualifier; the item modifier line has no such suffix.
Object.assign(tradeStatMappings, {
  'explicit.stat_4052037485': {
    key: 'flat-energy-shield',
    text: '+# to maximum Energy Shield',
  },
});
