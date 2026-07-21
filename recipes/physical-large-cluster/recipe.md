---
schemaVersion: 2
id: physical-large-cluster-jagged
title: Physical Large Cluster Jewel
summary: Jagged Fossil craft for the three-notable physical large cluster jewel.
tags: [cluster-jewel, physical, profit]
category: cluster-jewel
gameDataVersion: '3.26.0'
base:
  baseId: Metadata/Items/Jewels/JewelPassiveTreeExpansionLarge
  itemLevel: 83
  rarity: rare
  influences: []
  state: { fractured: false, synthesised: false, corrupted: false }
  variant:
    kind: cluster-jewel
    passiveCount: 8
    smallPassiveStatId: physical-damage
target:
  allOf:
    - { kind: explicit, modId: mod:battle-hardened }
    - { kind: explicit, modId: mod:furious-assault }
    - { kind: explicit, modId: mod:master-the-fundamentals }
  anyOf: []
  minimumMatched: null
craft:
  method: { kind: fossil, fossils: [jagged-fossil], resonatorSockets: 1 }
  resourceConsumption:
    source: authored-estimate
    materials:
      - { itemId: jagged-fossil, quantity: 30 }
      - { itemId: primitive-chaotic-resonator, quantity: 30 }
  startingMods: []
content:
  craftSteps:
    - {
        id: jagged-fossil,
        title: Use Jagged Fossils in one-socket resonators until the target is hit,
      }
---

# Physical Large Cluster Jewel

Buy an item-level 83+ Large Cluster Jewel with 8 passives, two jewel sockets,
and 12% increased Physical Damage small passives. The estimate intentionally
uses 30 Jagged Fossils and 30 one-socket resonators; it is not a probability
calculation.
