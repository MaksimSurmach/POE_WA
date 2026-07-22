---
schemaVersion: 1
id: fixture-v1-mean-20
title: fixture-v1-mean-20
summary: Synthetic integration compatibility fixture.
tags: [fixture]
category: fixture
gameVersion: 3.26.0
baseRequirements:
  {
    baseType: fixture-base,
    tradeQuery:
      {
        provider: poe-trade,
        query: { fixtureKey: fixture:base:legacy },
        schemaVersion: 1,
      },
  }
materials:
  [
    {
      id: fixture-material,
      label: Fixture material,
      quantityPerAttempt: 3,
      tradeQuery:
        {
          provider: poe-trade,
          query: { fixtureKey: fixture:material:legacy },
          schemaVersion: 1,
        },
    },
  ]
finishingCosts: []
output:
  {
    label: Fixture output,
    tradeQuery:
      {
        provider: poe-trade,
        query: { fixtureKey: fixture:output:legacy },
        schemaVersion: 1,
      },
  }
success: { mode: expected_attempts, expectedAttempts: 2 }
estimator: { strategy: mean_top_n, n: 11 }
craftSteps: [{ id: fixture-craft, title: Fixture craft }]
---

# fixture-v1-mean-20
