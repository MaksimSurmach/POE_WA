---
schemaVersion: 2
id: fixture-v2-harvest-d-14
title: fixture-v2-harvest-d-14
summary: Synthetic integration fixture.
tags: [fixture]
category: fixture
gameDataVersion: fixture-1
base:
  {
    baseId: fixture:base:c,
    itemLevel: 83,
    rarity: rare,
    influences: [],
    state: { corrupted: false, fractured: false, synthesised: false },
    variant: { kind: none },
  }
target:
  {
    allOf: [{ kind: explicit, modId: mod:fixture-d }],
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

# fixture-v2-harvest-d-14
