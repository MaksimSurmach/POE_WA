# MAX-1287: partial belt research demo

Two guide-backed Stygian Vise research profiles are available through `pnpm market:seed-library`. Their guides do not specify all thresholds, so they have no executable belt rules. They cannot produce confirmed matches until a user creates a separately sourced, explicit target. Original catalog entries and stored snapshots are preserved.

## Synthetic import walkthrough

Start the app with PostgreSQL (see README), create a Belt target, and set league `Demo`, patch `fixture`, base `Stygian Vise`. The following **synthetic** rules can be pasted into the optional rules field:

```json
{
  "version": 1,
  "minItemLevel": 84,
  "influences": [],
  "corrupted": false,
  "mods": [{ "id": "life", "minValue": 80, "maxTier": 2 }]
}
```

Open the target's import dialog. Replace the sample rows with the example below, retain the target ID and current captured time supplied by the form, and keep `dataKind` as `demo`. Neither the rule nor the prices are a real build or market observation.

```json
{
  "externalId": "fixture-1",
  "price": 10,
  "item": {
    "baseType": "Stygian Vise",
    "rarity": "rare",
    "league": "Demo",
    "patch": "fixture",
    "currency": "chaos",
    "itemLevel": 84,
    "corrupted": false,
    "influences": [],
    "seller": "fixture-seller",
    "status": "listed",
    "mods": [{ "id": "life", "value": 90, "tier": 2 }]
  }
}
```

Use `currency: "chaos"` in the import. Open the resulting snapshot to see `MATCH` and `INSUFFICIENT_DATA`. Remove `tier` to see `PARTIAL`, or lower `value` to see `REJECT`. Unknown fields cannot establish a match; `modsComplete: true` is required before an absent required modifier is treated as a mismatch. Raw item JSON is preserved. The v1 endpoint computes a separate interpretation; existing snapshot summaries remain user-selected, not verified.

The conservative asking-price indicator requires five distinct sellers and an observation at most 24 hours old. It is an asking price, not a sale, and uses the lowest observed price per seller. Demo and observed data must not be mixed. Craft cost and profit are unavailable: probability, base and materials have not been validated. No live rare observation was supplied, so the real-data gate remains blocked.

## Remaining work

Add at least one more genuinely sourced belt target and verify quantitative rules, source a permitted real rare listing, connect dated base/material prices and a reproducible method to the existing economics model, implement the ranking and calculation drill-down, then run browser, process-restart and CI acceptance. The present slice is not completion of MAX-1287.
