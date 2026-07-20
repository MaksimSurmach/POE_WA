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
