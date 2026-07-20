# POE Worksmith Automator

## Local PostgreSQL

Requirements: Node.js 22, pnpm 11, and Docker Compose.

```bash
cp .env.development.example .env.development
pnpm db:up
pnpm db:migrate
pnpm db:check
```

The development service binds only to `127.0.0.1:54322`. Its checked-in
credentials are local-only and must never be reused outside this Compose stack.

Use the isolated, disposable test database on port `54324`:

```bash
cp .env.test.example .env.test
pnpm db:test:up
set -a && source .env.test && set +a
pnpm test:integration
```

Stop both services with `pnpm db:down`. Development data uses a named volume;
test data uses a temporary filesystem and is discarded with the container.

`pnpm db:setup` creates the local database and applies every migration from an
empty volume. Migrations are forward-only in shared environments: fix a bad
migration with a new corrective migration. During local development only,
`pnpm db:reset` removes the local database volume, recreates PostgreSQL, and
reapplies the full migration history. This command deletes local data.

## Supabase staging

1. Create a Free project in the Supabase dashboard.
2. Copy `.env.staging.example` to `.env.staging` and replace the placeholders
   with the connection string shown by the dashboard's **Connect** action.
3. Build and check it without changing application code:

   ```bash
   pnpm --filter @poe-worksmith/server build
   node --env-file=.env.staging apps/server/dist/checkDatabase.js
   ```

For a persistent IPv6-capable backend, prefer the direct endpoint
`db.<project-ref>.supabase.co:5432`. On an IPv4-only host, use the shared
Supavisor session pooler on port `5432`. Reserve transaction mode on port
`6543` for short-lived/serverless clients; it does not support prepared
statements. Keep migrations and administrative commands on a direct or session
connection.

All `.env*` files are ignored except the placeholder `*.example` files. Never
commit database passwords or generated Supabase secrets.
