import {
  marketResearchSnapshotSchema,
  marketResearchSnapshotSummarySchema,
  marketTargetSchema,
  beltPriceUpdateSchema,
} from '@poe-worksmith/contracts';
import type { Pool } from 'pg';

import {
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
      const result = await pool.query<{
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
      return marketResearchSnapshotSchema.parse({
        ...row.summary,
        listings: row.listings,
      });
    },
  };
}
