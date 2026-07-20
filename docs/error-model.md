# Domain error model

Application failures use `DomainError` and a stable uppercase code. Decisions
must inspect `disposition`, never message text:

- `retryable`: retry with bounded backoff; do not publish incomplete data.
- `permanent`: stop retrying until inputs or configuration change.
- `degraded`: keep the last successful catalog and expose stale/partial state.

The taxonomy covers:

- recipe parsing and sync: `RECIPE_*`;
- market providers and queries: `MARKET_*`, `PROVIDER_*`, `NO_LISTINGS`;
- queue execution: `QUEUE_*`, `JOB_*`;
- snapshots: `SNAPSHOT_*`;
- calculations: `CALCULATION_*`, `INSUFFICIENT_LISTINGS`,
  `UNSUPPORTED_CURRENCY`;
- refresh cycles: `REFRESH_*`;
- publication: `PUBLICATION_*`;
- persistence adapters: `PERSISTENCE_*`.

Use `Result<T>` for expected application failures. `DomainError.cause` retains
internal diagnostics for logs. `serializeDomainError` and `DomainError.toJSON`
emit only the stable code, classification, retry flag, and safe public message.
