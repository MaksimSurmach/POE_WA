# Importing observations of rare-item asking prices

The market workbench imports observations explicitly selected by the user. It does
not infer that an item matches a target, that a listing was sold, or that the
observed price is achievable. The UI displays `comparability: user_selected`.

Create a target in the UI first. Open its import form to get its UUID and a
synthetic example. Replace example prices and item bodies with observations you
are entitled to use, supply their actual time and source, and set `dataKind` to
`observed` only for real evidence.

```json
{
  "targetId": "10000000-0000-4000-8000-000000000001",
  "capturedAt": "2026-01-10T12:00:00.000Z",
  "sourceUrl": "https://www.pathofexile.com/trade",
  "currency": "divine",
  "dataKind": "demo",
  "notes": "Synthetic documentation example; not a market quote.",
  "listings": [
    {
      "externalId": "example-listing-1",
      "price": 2,
      "item": {
        "baseType": "Stygian Vise",
        "explicitMods": [{ "description": "+90 to maximum Life", "flags": {} }]
      }
    }
  ]
}
```

The UUID above is a placeholder. The request must reference an existing target.
The target supplies game, realm, league, patch, revision and profile digest. If a
raw item declares a different league, the import is rejected. Missing raw league
metadata does not prove a match; the importer remains responsible for selecting
the appropriate market.

## Import rules

- HTTPS source URL without embedded credentials.
- One original currency per snapshot: `chaos` or `divine`. No inferred conversion.
- At most 1,000 listings and a 2 MiB request body.
- Finite positive prices; duplicate explicit listing identities are rejected.
- An empty, successfully checked selection requires `listings: []` and
  `emptyResult: true`. An error or failed source request is not a zero result.
- `capturedAt` is when the market was observed, not when the file was uploaded.
  Timestamps more than five minutes in the future are rejected.
- Raw item JSON is preserved. Legacy string modifiers and newer object modifiers
  are retained without pretending that all IDs, tiers, or affix types are known.
- `demo` and `observed` observations are separate. The main market view excludes
  imported demonstration records. The built-in UI demo is never sent to the API.

Repeated equivalent imports for the same immutable target and observation time
return the stored snapshot instead of duplicating it. Each stored snapshot has
its own UUID, SHA-256 digest, target version, capture/import times and provenance.
Quartiles describe only the imported selection. They are not population estimates
or completed-sale prices.

## Endpoints

| Method | Path                           | Purpose                                                      |
| ------ | ------------------------------ | ------------------------------------------------------------ |
| GET    | `/api/market`                  | Targets, snapshot summaries, storage and source capabilities |
| POST   | `/api/market/targets`          | Create a target and its source links                         |
| POST   | `/api/market/snapshots/import` | Validate and persist an immutable observation                |
| GET    | `/api/market/snapshots/:id`    | Inspect the original imported rows                           |

The research workbench is currently for a single trusted operator. Run it on
loopback or behind an existing private access boundary. The new write endpoints
are not a multi-user authentication system.
