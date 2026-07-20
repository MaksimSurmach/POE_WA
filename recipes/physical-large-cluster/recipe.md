---
schemaVersion: 1
id: physical-large-cluster
title: Physical Large Cluster Jewel
summary: Harvest-craft a physical large cluster jewel.
tags:
  - profit
  - cluster-jewel
category: cluster-jewel
gameVersion: '3.25'
baseRequirements:
  baseType: Large Cluster Jewel
  itemClass: Jewel
  minItemLevel: 84
  tradeQuery:
    provider: poe-trade
    schemaVersion: 1
    query:
      query:
        type: Large Cluster Jewel
        filters:
          misc_filters:
            filters:
              ilvl:
                min: 84
      sort:
        price: asc
materials:
  - id: primal-crystallised-lifeforce
    label: Primal Crystallised Lifeforce
    quantityPerAttempt: 150
    tradeQuery:
      provider: poe-trade
      schemaVersion: 1
      query:
        exchange:
          have:
            - divine
          want:
            - primal-crystallised-lifeforce
success:
  mode: expected_attempts
  expectedAttempts: 6
finishingCosts:
  - id: divine-orb
    label: Divine Orb
    quantity: 1
    tradeQuery:
      provider: poe-trade
      schemaVersion: 1
      query:
        exchange:
          have:
            - divine
          want:
            - chaos
craftSteps:
  - id: harvest-reforge
    title: Reforge with Physical
    metadata:
      method: harvest
output:
  label: Physical Large Cluster Jewel
  tradeQuery:
    provider: poe-trade
    schemaVersion: 1
    query:
      query:
        status:
          option: securable
        type: Large Cluster Jewel
        stats:
          - type: and
            filters:
              - id: explicit.stat_3948993189
                value:
                  min: 3
      sort:
        price: asc
estimator:
  strategy: median_top_n
  n: 10
---

# Physical Large Cluster Jewel

1. Buy an item-level 84 Large Cluster Jewel.
2. Reforge it with Physical using Primal Crystallised Lifeforce.
3. Repeat until all required modifiers are present.
4. Apply the finishing Divine Orb only after the modifier set is complete.

The structured front matter is the sole input for market queries and pricing.
