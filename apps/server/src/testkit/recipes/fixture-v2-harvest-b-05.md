---
schemaVersion: 2
id: fixture-v2-harvest-b-05
title: fixture-v2-harvest-b-05
summary: Synthetic integration fixture.
tags: [fixture]
category: fixture
gameDataVersion: fixture-1
base:
  {
    baseId: fixture:base:a,
    itemLevel: 83,
    rarity: rare,
    influences: [],
    state: { corrupted: false, fractured: false, synthesised: false },
    variant: { kind: none },
  }
target:
  {
    allOf: [{ kind: explicit, modId: mod:fixture-b }],
    anyOf: [],
    minimumMatched: null,
  }
craft:
  {
    method: { kind: harvest-reforge, tag: physical },
    resourceConsumption:
      {
        source: authored-estimate,
        materials: [{ itemId: fixture:lifeforce, quantity: 100 }],
      },
    startingMods: [],
  }
content: { craftSteps: [] }
---

# fixture-v2-harvest-b-05
