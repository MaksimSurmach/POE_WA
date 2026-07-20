---
# Copy this file to recipes/<recipe-id>/recipe.md. IDs must be unique,
# lowercase kebab-case. Keep all pricing inputs in this YAML block.
schemaVersion: 1
id: your-recipe-id
title: Your Recipe Title
summary: One sentence describing the finished craft.
tags:
  - profit
category: item-category
# Use the current Path of Exile release, for example 3.25 or 3.25.1.
gameVersion: '3.25'
baseRequirements:
  baseType: Exact Base Type
  itemClass: Item Class
  minItemLevel: 84
  # This object is sent to the named provider; Markdown is never parsed into it.
  tradeQuery:
    provider: poe-trade
    schemaVersion: 1
    query:
      query:
        type: Exact Base Type
        filters:
          misc_filters:
            filters:
              ilvl:
                min: 84
      sort:
        price: asc
materials:
  - id: primary-material
    label: Primary Material
    quantityPerAttempt: 1
    tradeQuery:
      provider: poe-trade
      schemaVersion: 1
      query:
        exchange:
          have:
            - divine
          want:
            - primary-material
# Choose exactly one mode: probability (0 < value <= 1) or expected_attempts (>= 1).
success:
  mode: expected_attempts
  expectedAttempts: 5
# Use [] when the craft has no finishing cost.
finishingCosts:
  - id: finishing-currency
    label: Finishing Currency
    quantity: 1
    tradeQuery:
      provider: poe-trade
      schemaVersion: 1
      query:
        exchange:
          have:
            - divine
          want:
            - finishing-currency
craftSteps:
  - id: main-craft
    title: Perform the main craft
    # Optional structured metadata; method becomes the runtime craft method.
    metadata:
      method: crafting-bench
output:
  label: Finished Item
  tradeQuery:
    provider: poe-trade
    schemaVersion: 1
    query:
      query:
        status:
          option: securable
        type: Exact Base Type
      sort:
        price: asc
# Supported strategies: cheapest, nth_cheapest, median_top_n, mean_top_n,
# percentile. The extra field is n or percentile where the strategy requires it.
estimator:
  strategy: median_top_n
  n: 10
---

# Your Recipe Title

Write the human guide here. This section is display-only and cannot define
market queries.

1. Buy the required base and materials.
2. Perform the craft steps.
3. Apply finishing costs only after success.

Local images are optional. Put them beside this file and use a relative path:

```markdown
![Descriptive alt text](images/example.png)
```

Allowed formats: PNG, JPEG, GIF, WebP, and AVIF. Remote URLs, symlinks, missing
files, and paths outside the recipe directory fail validation.
