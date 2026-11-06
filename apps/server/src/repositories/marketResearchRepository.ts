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
  marketDigest,
  type MarketResearchRepository,
  summarizeMarketSnapshot,
} from '../marketResearch.js';

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
        `with eligible as (
          select s.id, s.target_id, s.captured_at, s.currency, s.summary,
            s.summary->>'queryDigest' as query_digest,
            s.summary->>'targetDigest' as target_digest,
            s.summary->>'league' as league, s.summary->>'patch' as patch
          from market_research_snapshots s
          where s.captured_at >= $1 and s.captured_at <= $2
            and s.data_kind = 'observed' and s.summary->>'provenance' = 'collection'
            and s.summary->>'queryDigest' is not null
            and exists (
              select 1 from market_collection_runs r
              where r.target_id = s.target_id and r.payload->>'snapshotId' = s.id::text
                and r.trigger = 'scheduled' and r.status in ('succeeded', 'partial', 'empty')
                and r.payload->>'sourceId' = 'trade-compatible' and r.payload->>'cached' = 'false'
            )
        ), targets as (
          select e.target_id as id, t.profile->>'name' as name,
            count(*) filter (where e.summary->>'median' is not null) as priced
          from eligible e join market_targets t on t.id = e.target_id
          group by e.target_id, t.profile->>'name'
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
              'count', e.summary->'count', 'coverage', coalesce(e.summary->>'coverage', 'unknown')
            ) order by e.captured_at, e.id)
              from eligible e where (e.target_id, e.query_digest, e.target_digest, e.league, e.patch, e.currency)
                = (l.target_id, l.query_digest, l.target_digest, l.league, l.patch, l.currency))
          ) from latest l)
        ) as data`,
        [start, end, targetId ?? null],
      );
      return scheduledTradeTrendDataSchema.parse(result.rows[0]?.data);
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
