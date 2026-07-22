---
schemaVersion: 2
id: fixture-v2-fossil-c-09
title: fixture-v2-fossil-c-09
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
    allOf: [{ kind: explicit, modId: mod:fixture-c }],
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

# fixture-v2-fossil-c-09
