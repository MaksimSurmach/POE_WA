# Refresh and publication invariants

- Refresh transitions are `queued -> running -> published -> superseded` or
  `queued/running -> failed`. Repeating the same state is idempotent.
- At most one cycle may be `running`; application checks and a partial unique
  PostgreSQL index enforce this.
- Counts must be non-negative and completed plus failed cannot exceed total.
- Publication requires a non-empty, fully accounted running cycle with at least
  95% successful recipes. Integer arithmetic keeps the boundary exact.
- Publication locks the singleton catalog state. Repeating the same publication
  does not change its revision.
- A rejected or failed candidate never mutates the currently published cycle.
- Jobs use explicit queued/running/retry/terminal transitions.
- Snapshots require stable IDs, a provider status from 100 through 599, and an
  expiry strictly after capture time.
