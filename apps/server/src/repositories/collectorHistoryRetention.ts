import type { PoolClient } from 'pg';

const historyRetentionMs = 30 * 24 * 60 * 60 * 1000;

export async function cleanupCollectorHistory(
  client: Pick<PoolClient, 'query'>,
  options: { batchSize: number; now?: Date; signal?: AbortSignal },
) {
  const before = new Date(
    (options.now ?? new Date()).getTime() - historyRetentionMs,
  );
  const values = [before, options.batchSize];
  const total = { captures: 0, events: 0, listings: 0, requests: 0 };

  // Each delete is atomic. After an interruption, surviving FK links still protect captures.
  for (let batch = 0; batch < 20; batch++) {
    options.signal?.throwIfAborted();
    const events = await client.query(
      `delete from listing_events where id in (
        select id from listing_events where at < $1 order by at, id limit $2
      )`,
      values,
    );
    options.signal?.throwIfAborted();
    const listings = await client.query(
      `delete from listings where (schedule_id, item_id) in (
        select schedule_id, item_id from listings
        where greatest(last_seen_at, gone_at, first_missing_at) < $1
        order by greatest(last_seen_at, gone_at, first_missing_at), schedule_id, item_id limit $2
      )`,
      values,
    );
    options.signal?.throwIfAborted();
    const captures = await client.query(
      `with result_sources as materialized (
        select result#>>'{methodCost,source,captureId}' as id from recipe_results
        union
        select last_run_summary->>'captureId' from collector_state
      )
      delete from captures where id in (
        select c.id from captures c where c.captured_at < $1
          and not exists (select 1 from listings l where l.first_capture_id = c.id)
          and not exists (select 1 from listings l where l.last_capture_id = c.id)
          and not exists (select 1 from listing_events e where e.capture_id = c.id)
          and not exists (select 1 from result_sources r where r.id = c.id::text)
          and not exists (
            select 1 from recipe_price_observations o
            where o.source_snapshot_dedupe_key = 'collector:' || c.id::text
          )
        order by c.captured_at, c.id limit $2
      )`,
      values,
    );
    options.signal?.throwIfAborted();
    const requests = await client.query(
      `delete from run_requests where id in (
        select r.id from run_requests r
        where r.state in ('done', 'failed') and r.finished_at < $1
          and r.id <> (select id from run_requests order by requested_at desc, id desc limit 1)
        order by r.finished_at, r.id limit $2
      )`,
      values,
    );
    const counts = [captures, events, listings, requests].map(
      ({ rowCount }) => rowCount ?? 0,
    );
    total.captures += counts[0]!;
    total.events += counts[1]!;
    total.listings += counts[2]!;
    total.requests += counts[3]!;
    if (counts.every((count) => count < options.batchSize))
      return { ...total, batchLimitReached: false };
  }
  return { ...total, batchLimitReached: true };
}
