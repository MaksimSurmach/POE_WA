import {
  marketEconomyAttemptSchema,
  marketEconomySummarySchema,
  type MarketEconomyAttempt,
} from '@poe-worksmith/contracts';
import type { Pool } from 'pg';
import {
  summarizeEconomy,
  type MarketEconomyRepository,
  type StoredMarketEconomySnapshot,
} from '../marketEconomy.js';

export function createMarketEconomyRepository(
  pool: Pool,
): MarketEconomyRepository {
  return {
    async assertReady() {
      await pool.query('select id from market_economy_snapshots limit 0');
    },
    async list() {
      const result = await pool.query<{
        summary: Record<string, unknown>;
        payload_available: boolean;
      }>(
        'select summary, payload is not null as payload_available from market_economy_snapshots order by captured_at desc, id limit 100',
      );
      return result.rows.map((row) =>
        marketEconomySummarySchema.parse({
          ...row.summary,
          payloadAvailable: row.payload_available,
        }),
      );
    },
    async save(snapshot) {
      const result = await pool.query<{ payload: StoredMarketEconomySnapshot }>(
        `insert into market_economy_snapshots (id, league, category, payload_hash, captured_at, summary, payload)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
         on conflict (league, category, payload_hash, captured_at) do update set payload_hash = excluded.payload_hash
         returning payload`,
        [
          snapshot.id,
          snapshot.league,
          snapshot.category,
          snapshot.payloadHash,
          snapshot.capturedAt,
          JSON.stringify(summarizeEconomy(snapshot)),
          JSON.stringify(snapshot),
        ],
      );
      return result.rows[0]!.payload;
    },
    async find(id) {
      const result = await pool.query<{ payload: StoredMarketEconomySnapshot }>(
        'select payload from market_economy_snapshots where id = $1',
        [id],
      );
      return result.rows[0]?.payload ?? null;
    },
    async listAttempts() {
      const result = await pool.query<{
        id: string;
        league: string;
        category: MarketEconomyAttempt['category'];
        started_at: Date;
        completed_at: Date | null;
        status: Exclude<MarketEconomyAttempt['status'], 'interrupted'>;
        cache_status: MarketEconomyAttempt['cacheStatus'];
        error_code: string | null;
        snapshot_id: string | null;
      }>(
        'select id, league, category, started_at, completed_at, status, cache_status, error_code, snapshot_id from market_economy_attempts order by started_at desc limit 100',
      );
      return result.rows.map((row) =>
        marketEconomyAttemptSchema.parse({
          id: row.id,
          league: row.league,
          category: row.category,
          startedAt: row.started_at.toISOString(),
          completedAt: row.completed_at?.toISOString() ?? null,
          status:
            row.status === 'running' &&
            Date.now() - row.started_at.getTime() > 15 * 60_000
              ? 'interrupted'
              : row.status,
          cacheStatus: row.cache_status,
          errorCode: row.error_code,
          snapshotId: row.snapshot_id,
        }),
      );
    },
    async saveAttempt(attempt) {
      await pool.query(
        `insert into market_economy_attempts (id, league, category, started_at, completed_at, status, cache_status, error_code, snapshot_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (id) do update set completed_at = excluded.completed_at, status = excluded.status, cache_status = excluded.cache_status, error_code = excluded.error_code, snapshot_id = excluded.snapshot_id`,
        [
          attempt.id,
          attempt.league,
          attempt.category,
          attempt.startedAt,
          attempt.completedAt,
          attempt.status,
          attempt.cacheStatus,
          attempt.errorCode,
          attempt.snapshotId,
        ],
      );
    },
    async cleanup({ payloadBefore, snapshotsBefore }) {
      await pool.query(
        'update market_economy_snapshots set payload = null where payload is not null and captured_at < $1',
        [payloadBefore],
      );
      await pool.query(
        'delete from market_economy_snapshots where captured_at < $1',
        [snapshotsBefore],
      );
    },
  };
}
