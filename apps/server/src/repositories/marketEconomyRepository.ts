import { marketEconomySummarySchema } from '@poe-worksmith/contracts';
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
      const result = await pool.query<{ summary: unknown }>(
        'select summary from market_economy_snapshots order by captured_at desc, id limit 100',
      );
      return result.rows.map((row) =>
        marketEconomySummarySchema.parse(row.summary),
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
  };
}
