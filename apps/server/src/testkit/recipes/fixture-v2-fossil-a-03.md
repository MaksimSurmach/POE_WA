---
schemaVersion: 2
id: fixture-v2-fossil-a-03
title: fixture-v2-fossil-a-03
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
    allOf: [{ kind: explicit, modId: mod:fixture-a }],
    anyOf: [],
    minimumMatched: null,
  }
craft:
  {
    method: { kind: fossil, fossils: [fixture:jagged], resonatorSockets: 1 },
    resourceConsumption:
      {
        source: authored-estimate,
        materials:
          [
            { itemId: fixture:jagged, quantity: 2 },
            { itemId: fixture:resonator, quantity: 2 },
          ],
      },
    startingMods: [],
  }
content: { craftSteps: [] }
---

# fixture-v2-fossil-a-03
