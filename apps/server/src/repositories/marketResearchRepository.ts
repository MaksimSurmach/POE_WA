import {
  marketResearchSnapshotSchema,
  marketResearchSnapshotSummarySchema,
  marketTargetSchema,
  scheduledTradeTrendDataSchema,
  beltPriceUpdateSchema,
  marketCollectionRunSchema,
  type MarketResearchSnapshot,
} from '@poe-worksmith/contracts';
import type { Pool, PoolClient } from 'pg';

import {
  summarizeTradeHistory,
  tradeDashboardHistorySchema,
} from '../tradeDashboard.js';

import {
  marketDigest,
  type MarketResearchRepository,
  summarizeMarketSnapshot,
} from '../marketResearch.js';

const scheduledCaptures = `scheduled as materialized (
          select distinct on (r.target_id, p."snapshotId") r.target_id, p."snapshotId" as snapshot_id,
            p."reportedTotal" as reported_total, p."fetchedCount" as captured_count, coalesce(p.inexact, false) as inexact
          from market_collection_runs r
          cross join lateral jsonb_to_record(r.payload) as p("snapshotId" uuid, "sourceId" text, cached boolean, "reportedTotal" integer, "fetchedCount" integer, inexact boolean)
          where r.trigger = 'scheduled' and r.status in ('succeeded', 'partial', 'empty')
            and r.completed_at >= $1 and r.started_at <= $2
            and p."sourceId" = 'trade-compatible' and p.cached = false and p."snapshotId" is not null
          order by r.target_id, p."snapshotId", r.completed_at desc, r.id desc
        )`;

/** Dedicated immutable research records. Legacy recipe refresh retention does not delete them. */
export function createMarketResearchRepository(
  pool: Pool,
): MarketResearchRepository {
  return {
    async listPriceUpdates(targetId) {
      const result = await pool.query<{ payload: unknown }>(
        'select payload from belt_price_updates where target_id = $1 order by created_at desc, id',
        [targetId],
      );
      return result.rows.map((row) => beltPriceUpdateSchema.parse(row.payload));
    },
    async savePriceUpdate(update) {
      const result = await pool.query<{ payload: unknown }>(
        `insert into belt_price_updates (id, target_id, digest, created_at, data_kind, payload) values ($1, $2, $3, $4, $5, $6::jsonb) on conflict (digest) do update set digest = excluded.digest returning payload`,
        [
          update.id,
          update.targetId,
          update.digest,
          update.createdAt,
          update.dataKind,
          JSON.stringify(update),
        ],
      );
      return beltPriceUpdateSchema.parse(result.rows[0]?.payload);
    },
    async listTargets() {
      const result = await pool.query<{ profile: unknown }>(
        'select profile from market_targets order by created_at desc, id',
      );
      return result.rows.map((row) => marketTargetSchema.parse(row.profile));
    },
    async findTarget(id) {
      const result = await pool.query<{ profile: unknown }>(
        'select profile from market_targets where id = $1',
        [id],
      );
      return result.rows[0]
        ? marketTargetSchema.parse(result.rows[0].profile)
        : null;
    },
    async saveTarget(target) {
      const result = await pool.query<{ profile: unknown }>(
        `insert into market_targets (id, digest, profile, created_at)
         values ($1, $2, $3::jsonb, $4)
         on conflict (digest) do update set digest = excluded.digest
         returning profile`,
        [target.id, target.digest, JSON.stringify(target), target.createdAt],
      );
      return marketTargetSchema.parse(result.rows[0]!.profile);
    },
    async readScheduledTradeTrend(start, end, targetId) {
      // The Raspberry scraper assigns independent IDs to runs and snapshots.
      const result = await pool.query<{ data: unknown }>(
        `with ${scheduledCaptures}, eligible as (
          select s.id, s.target_id, s.captured_at, s.currency, s.summary, r.reported_total, r.captured_count, r.inexact,
            s.summary->>'queryDigest' as query_digest,
            s.summary->>'targetDigest' as target_digest,
            s.summary->>'league' as league, s.summary->>'patch' as patch
          from scheduled r join market_research_snapshots s on s.id = r.snapshot_id and s.target_id = r.target_id
          where s.captured_at >= $1 and s.captured_at <= $2
            and s.data_kind = 'observed' and s.summary->>'provenance' = 'collection'
            and s.summary->>'queryDigest' is not null

        ), target_counts as (
          select target_id as id, count(*) filter (where summary->>'median' is not null) as priced
          from eligible group by target_id
        ), targets as (
          select c.id, c.priced,
            case t.profile->>'slot'
              when 'starting-base' then concat_ws(' · ', t.profile->'baseTypes'->>0,
                'iLvl ' || (t.profile->>'minItemLevel'),
                regexp_replace(t.profile->>'name', '^base:(base:|.*/)?', ''))
              when 'crafted-item' then concat_ws(' · ', t.profile->'baseTypes'->>0,
                'iLvl ' || (t.profile->>'minItemLevel'),
                case when t.profile#>>'{tradeSearch,fractured}' = 'true' then 'Fractured' end,
                right(t.profile->>'name', 8))
              else t.profile->>'name'
            end as name
          from target_counts c join market_targets t on t.id = c.id
        ), latest as (
          select * from eligible
          where target_id = coalesce($3::uuid, (select id from targets order by priced desc, name, id limit 1))
          order by captured_at desc, id desc limit 1
        )
        select jsonb_build_object(
          'targets', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name)
            order by name, id) from targets), '[]'::jsonb),
          'series', (select jsonb_build_object(
            'targetId', l.target_id, 'league', l.league, 'patch', l.patch, 'currency', l.currency,
            'points', (select jsonb_agg(jsonb_build_object(
              'id', e.id, 'capturedAt', e.summary->'capturedAt', 'median', e.summary->'median',
              'count', e.summary->'count', 'coverage', coalesce(e.summary->>'coverage', 'unknown'),
              'reportedTotal', e.reported_total, 'capturedCount', e.captured_count, 'inexact', e.inexact
            ) order by e.captured_at, e.id)
              from eligible e where (e.target_id, e.query_digest, e.target_digest, e.league, e.patch, e.currency)
                = (l.target_id, l.query_digest, l.target_digest, l.league, l.patch, l.currency))
          ) from latest l)
        ) as data`,
        [start, end, targetId ?? null],
      );
      const data = scheduledTradeTrendDataSchema.parse(result.rows[0]?.data);
      const [previous, current] = data.series?.points.slice(-2) ?? [];
      if (
        !data.series ||
        !previous ||
        !current ||
        previous.capturedAt >= current.capturedAt ||
        previous.coverage !== 'complete' ||
        current.coverage !== 'complete' ||
        previous.inexact ||
        current.inexact
      )
        return data;

      const ids = await pool.query<{
        id: string;
        listings: Array<string | null>;
      }>(
        `select id, array(select listing->>'externalId' from jsonb_array_elements(listings) listing) as listings
         from market_research_snapshots where id = any($1::uuid[])
           and summary->>'rawAvailable' is distinct from 'false'`,
        [[previous.id, current.id]],
      );
      const priorIds = ids.rows.find((row) => row.id === previous.id)?.listings;
      const currentIds = ids.rows.find(
        (row) => row.id === current.id,
      )?.listings;
      if (
        !priorIds ||
        !currentIds ||
        priorIds.length < previous.count ||
        currentIds.length < current.count ||
        priorIds.some((id) => !id) ||
        currentIds.some((id) => !id)
      )
        return data;

      const prior = new Set(priorIds);
      const present = new Set(currentIds);
      data.series.activity = {
        previousAt: previous.capturedAt,
        missingCount: [...prior].filter((id) => !present.has(id)).length,
        newCount: [...present].filter((id) => !prior.has(id)).length,
      };
      return data;
    },
    async readTradeDashboard(start, end, league, targetId) {
      const horizon = new Date(
        start.getTime() - (end.getTime() - start.getTime()) - 2 * 86_400_000,
      );
      const result = await pool.query<{
        league: string | null;
        histories: unknown;
      }>(
        `with ${scheduledCaptures}, eligible as materialized (
          select s.id, s.target_id, s.captured_at, s.currency, s.summary,
            r.captured_count, r.inexact,
            array[s.summary->>'queryDigest', s.summary->>'targetDigest',
                  s.summary->>'league', s.summary->>'patch', s.currency] as scope
          from scheduled r join market_research_snapshots s on s.id = r.snapshot_id and s.target_id = r.target_id
          where s.captured_at between $1 and $2
            and s.data_kind = 'observed' and s.summary->>'provenance' = 'collection'
            and s.summary->>'queryDigest' is not null
            and ($4::uuid is null or s.target_id = $4)
        ), league as (
          select coalesce($3::text,
            (select profile->>'league' from market_targets where id = $4),
            (select summary->>'league' from eligible order by captured_at desc, id desc limit 1),
            (select profile->>'league' from market_targets order by created_at desc, id limit 1)
          ) as name
        ), targets as materialized (
          select t.id, t.profile, coalesce(settings.interval_minutes, 60) as interval_minutes
          from market_targets t left join market_collection_settings settings on settings.target_id = t.id
          where t.profile->>'league' = (select name from league) and ($4::uuid is null or t.id = $4)
        ), scoped as (
          select e.*,
            first_value(scope) over recent as latest_scope,
            row_number() over recent as recent_rank
          from eligible e join targets t on t.id = e.target_id
          where e.summary->>'league' = (select name from league)
          window recent as (partition by e.target_id order by e.captured_at desc, e.id desc)
        ), bounded as (
          select * from (
            select scoped.*, min(recent_rank) filter (where scope is distinct from latest_scope)
              over (partition by target_id) as scope_boundary
            from scoped
          ) scoped_epochs
          where recent_rank < coalesce(scope_boundary, 385) and recent_rank <= 384
        ), recent as (
          select bounded.*, count(*) filter (
            where summary->>'coverage' = 'complete' and not inexact
              and summary->>'inexact' is distinct from 'true'
              and summary->>'rawAvailable' is distinct from 'false'
          ) over (partition by target_id) >= 2 as has_comparison_history
          from bounded
        ), histories as (
          select r.target_id, jsonb_agg(jsonb_build_object(
            'id', r.id, 'at', r.summary->'capturedAt', 'currency', r.currency,
            'ask', r.summary->'median',
            'captured', coalesce(r.captured_count,
              case when r.summary->>'rawAvailable' is distinct from 'false' then jsonb_array_length(s.listings) end),
            'coverage', case when r.inexact or r.summary->>'inexact' = 'true' then 'partial'
              else coalesce(r.summary->>'coverage', 'unknown') end,
            'identities', case when r.has_comparison_history and r.summary->>'rawAvailable' is distinct from 'false' then
              array(select listing->>'externalId' from jsonb_array_elements(s.listings) listing) end,
            'sellers', case when r.recent_rank = 1 and r.summary->>'rawAvailable' is distinct from 'false' then
              array(select lower(nullif(btrim(listing#>>'{item,seller}'), '')) from jsonb_array_elements(s.listings) listing) end
          ) order by r.captured_at, r.id) as captures
          from recent r join market_research_snapshots s on s.id = r.id
          group by r.target_id
        )
        select league.name as league, coalesce((select jsonb_agg(jsonb_build_object(
          'id', t.id, 'slot', t.profile->>'slot',
          'name', case t.profile->>'slot'
            when 'starting-base' then concat_ws(' · ', t.profile->'baseTypes'->>0,
              'iLvl ' || (t.profile->>'minItemLevel'), regexp_replace(t.profile->>'name', '^base:(base:|.*/)?', ''))
            when 'crafted-item' then concat_ws(' · ', t.profile->'baseTypes'->>0,
              'iLvl ' || (t.profile->>'minItemLevel'),
              case when t.profile#>>'{tradeSearch,fractured}' = 'true' then 'Fractured' end, right(t.profile->>'name', 8))
            else t.profile->>'name' end,
          'intervalMinutes', t.interval_minutes, 'captures', coalesce(h.captures, '[]'::jsonb)
        ) order by t.profile->>'name', t.id)
          from targets t left join histories h on h.target_id = t.id), '[]'::jsonb) as histories
        from league`,
        [horizon, end, league ?? null, targetId ?? null],
      );
      const rows = tradeDashboardHistorySchema.parse(result.rows[0]?.histories);
      const dashboard = rows.map((history) =>
        summarizeTradeHistory(
          history,
          start.getTime(),
          end.getTime(),
          Boolean(targetId),
        ),
      );
      return {
        league: result.rows[0]?.league ?? null,
        items: dashboard.map((row) => row.item),
        points: dashboard.flatMap((row) => row.points),
      };
    },
    async listSnapshots() {
      const result = await pool.query<{ summary: unknown }>(
        'select summary from market_research_snapshots order by captured_at desc, id',
      );
      return result.rows.map((row) =>
        marketResearchSnapshotSummarySchema.parse(row.summary),
      );
    },
    async findSnapshot(id) {
      const result = await pool.query<{
        summary: Record<string, unknown>;
        listings: unknown;
      }>(
        'select summary, listings from market_research_snapshots where id = $1',
        [id],
      );
      const row = result.rows[0];
      return row
        ? marketResearchSnapshotSchema.parse({
            ...row.summary,
            listings: row.listings,
          })
        : null;
    },
    async saveSnapshot(snapshot) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const persisted = await insertMarketResearchSnapshot(client, snapshot);
        const queryDigest = marketDigest({
          schemaVersion: 1,
          targetDigest: persisted.targetDigest,
          sourceUrl: persisted.sourceUrl,
        });
        const run = marketCollectionRunSchema.parse({
          id: persisted.id,
          targetId: persisted.targetId,
          targetDigest: persisted.targetDigest,
          league: persisted.league,
          patch: persisted.patch,
          sourceId: 'manual-import',
          sourceUrl: persisted.sourceUrl,
          queryDigest,
          dataKind: persisted.dataKind,
          trigger: 'manual',
          status: 'partial',
          coverage: 'partial',
          reportedTotal: null,
          returnedCount: persisted.listings.length,
          fetchedCount: persisted.listings.length,
          cached: false,
          currency: persisted.currency,
          listings: persisted.listings.map((listing) => ({
            ...listing,
            fingerprint: marketDigest(listing),
          })),
          startedAt: persisted.retrievedAt,
          capturedAt: persisted.capturedAt,
          completedAt: persisted.retrievedAt,
          batchCount: 0,
          listingCount: persisted.listings.length,
          errorCode: null,
          retryAt: null,
          snapshotId: persisted.id,
          cancelRequested: false,
        });
        await client.query(
          `insert into market_collection_runs
            (id, target_id, target_digest, league, patch, status, trigger, started_at, heartbeat_at, completed_at, payload)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10::jsonb)
           on conflict (id) do nothing`,
          [
            run.id,
            run.targetId,
            run.targetDigest,
            run.league,
            run.patch,
            run.status,
            run.trigger,
            run.startedAt,
            run.completedAt,
            JSON.stringify(run),
          ],
        );
        await client.query('commit');
        return persisted;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** Shared immutable snapshot write; the caller owns its transaction and publication link. */
export async function insertMarketResearchSnapshot(
  client: PoolClient,
  snapshot: MarketResearchSnapshot,
): Promise<MarketResearchSnapshot> {
  const result = await client.query<{
    summary: Record<string, unknown>;
    listings: unknown;
  }>(
    `insert into market_research_snapshots
      (id, target_id, digest, captured_at, retrieved_at, data_kind, currency, summary, listings)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
     on conflict (digest) do update set digest = excluded.digest
     returning summary, listings`,
    [
      snapshot.id,
      snapshot.targetId,
      snapshot.digest,
      snapshot.capturedAt,
      snapshot.retrievedAt,
      snapshot.dataKind,
      snapshot.currency,
      JSON.stringify(summarizeMarketSnapshot(snapshot)),
      JSON.stringify(snapshot.listings),
    ],
  );
  const row = result.rows[0]!;
  const persisted = marketResearchSnapshotSchema.parse({
    ...row.summary,
    listings: row.listings,
  });
  return persisted;
}
