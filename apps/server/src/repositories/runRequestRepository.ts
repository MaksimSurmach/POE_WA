import { DomainError } from '@poe-worksmith/domain';
import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import { collectorState, runRequests } from '../schema.js';

export async function enqueueRunRequest(pool: Pool, recipeId: string | null) {
  // One statement commits both the queue row and its wake notification.
  const { rows } = await pool.query<{ id: string }>(
    `with queued as (
      insert into run_requests (scope, recipe_id)
      select $1, $2::text
      where $2 is null or exists (
        select 1 from recipes where id = $2 and active for share
      )
      on conflict (scope, (coalesce(recipe_id, ''))) where state = 'queued'
      do update set scope = excluded.scope
      returning id
    )
    select id, pg_notify('worksmith_wake', '') from queued`,
    [recipeId === null ? 'all' : 'recipe', recipeId],
  );
  const request = rows[0];
  if (!request) throw new DomainError('PERSISTENCE_NOT_FOUND');
  return request.id;
}

export async function readCollectorStatus(pool: Pool) {
  const db = drizzle({ client: pool });
  const [[state], [latestRequest], { rows }] = await Promise.all([
    db.select().from(collectorState).where(eq(collectorState.id, 1)),
    db
      .select()
      .from(runRequests)
      .orderBy(desc(runRequests.requestedAt), desc(runRequests.id))
      .limit(1),
    pool.query<{ lockHeld: boolean; nextDueAt: Date | null }>(
      `select exists (
        select 1 from pg_locks
        where locktype = 'advisory' and granted and mode = 'ExclusiveLock'
          and database = (select oid from pg_database where datname = current_database())
          and objsubid = 1
          and ((classid::bigint << 32) | objid::bigint) = hashtext('poe-worksmith:collector')::bigint
      ) as "lockHeld",
      (select min(greatest(next_due_at, retry_at, leased_until))
       from collector_schedule where enabled) as "nextDueAt"`,
    ),
  ]);
  return {
    collectorState: state ?? null,
    latestRequest: latestRequest ?? null,
    ...rows[0]!,
  };
}
