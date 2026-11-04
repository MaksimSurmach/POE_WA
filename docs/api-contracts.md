# API state and error contracts

Catalog and recipe responses use the shared schemas in
`@poe-worksmith/contracts` and a `state` discriminator:

- `success`: complete current data, `isStale: false`, no `errorCode`;
- `stale`: the last successful published data, `isStale: true`;
- `partial`: usable data with a machine-readable `errorCode`;
- `error`: `data: null` plus the unified public error envelope.

Every resource state includes `correlationId`, `publishedAt`, `isStale`,
`refreshStatus`, `lastSuccessfulAt`, and `errorCode`. `partial` always contains a
typed data value; complete absence is represented only by `error` with null
data.

All non-resource HTTP errors use:

```json
{
  "correlationId": "UUID",
  "error": {
    "category": "market",
    "code": "PROVIDER_UNAVAILABLE",
    "disposition": "retryable",
    "message": "The market provider is temporarily unavailable.",
    "retryable": true
  }
}
```

The API echoes a valid `x-request-id` UUID or generates one, and returns the same
value in the header and body. Internal causes are logged server-side only.

The handbook detail has one `method` object, target signature, verification state, uncertainty notes, step prices and source timestamps. It has no `variants` field. Catalog snapshots contain only verified, seller-deduplicated comparable listings; original raw listings remain in storage. Listing previews are explicitly labelled observed items; target previews are templates. `POST /api/refresh` queues one bounded run; `GET /api/refresh` supplies progress and failure state.

`GET /api/trends?range=24h|7d|30d|1y` (default `7d`) lists every active recipe
with a trend summary for the current league and current recipe revision.
`GET /api/trends/:recipeId?range=…` returns one series as fixed UTC buckets:
hourly for 24h, 4-hourly for 7d, and daily for 30d and 1y. At most 366
buckets are returned. Only buckets with observations are returned; a missing
bucket is a gap, never a zero. Each bucket has open/high/low/close ask, the
number of independent source snapshots, the last contemporaneous craft cost
and seller counts. `summary.change` exists only when the window holds at least
two independent observations at different times. The series uses the
currency of the latest observation; other currencies are listed in
`excludedCurrencies` and never mixed in. Responses state
`priceBasis: "asking"` and `salesVolume: "unknown"`. An invalid range or
recipe ID returns 400 `MARKET_QUERY_INVALID`, and an unknown or inactive
recipe returns 404. Without a resolved league the response is
`state: "unavailable"`; without history it is `state: "empty"`.
