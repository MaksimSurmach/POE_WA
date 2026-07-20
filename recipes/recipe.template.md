---
# Copy this file to recipes/<recipe-id>/recipe.md. IDs must be unique,
# lowercase kebab-case. Canonical IDs are resolved by later provider adapters.
schemaVersion: 2
id: your-recipe-id
title: Your Recipe Title
summary: Optional display text.
tags:
  - profit
category: item-category
gameDataVersion: '3.26.0'
base:
  baseId: Metadata/Items/Jewels/JewelPassiveTreeExpansionLarge
  itemLevel: 84
  rarity: rare
  influences: []
  state: { fractured: false, synthesised: false, corrupted: false }
  variant: { kind: none }
target: { allOf: [], anyOf: [], minimumMatched: null }
craft:
  method: { kind: harvest-reforge, tag: physical }
  startingMods: []
content:
  craftSteps:
    - id: main-craft
      title: Perform the main craft
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
