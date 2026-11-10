import { DomainError } from '@poe-worksmith/domain';
import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import { readCollectorQueue } from './collectorQueue.js';
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
      on conflict (scope, (coalesce(recipe_id, ''))) where state in ('queued', 'running')
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
  const [[state], [latestRequest], queue] = await Promise.all([
    db
      .select({
        id: collectorState.id,
        lastRunStartedAt: collectorState.lastRunStartedAt,
        lastRunFinishedAt: collectorState.lastRunFinishedAt,
        lastRunStatus: collectorState.lastRunStatus,
        lastRunSummary: collectorState.lastRunSummary,
        blockedReason: collectorState.blockedReason,
        sessionCheckedAt: collectorState.sessionCheckedAt,
      })
      .from(collectorState)
      .where(eq(collectorState.id, 1)),
    db
      .select()
      .from(runRequests)
      .orderBy(desc(runRequests.requestedAt), desc(runRequests.id))
      .limit(1),
    readCollectorQueue(pool, new Date()),
  ]);
  return {
    collectorState: state ?? null,
    latestRequest: latestRequest ?? null,
    lockHeld: queue.leaderPid !== null,
    nextDueAt: queue.nextDueAt,
  };
}
