import {
  marketCollectionRunSchema,
  marketImportListingSchema,
  marketCollectionSettingsSchema,
  marketTargetSchema,
  type MarketCollectionRun,
  type MarketCollectionSettings,
} from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';
import type { Pool } from 'pg';

import {
  createImportedMarketSnapshot,
  marketDigest,
} from '../marketResearch.js';
import { insertMarketResearchSnapshot } from './marketResearchRepository.js';

import type {
  MarketCollectionObservation,
  MarketCollectionStore,
} from '../marketCollection.js';

export function createMarketCollectionRepository(
  pool: Pool,
): MarketCollectionStore {
  return {
    async isSourceBlocked(sourceId) {
      const result = await pool.query<{ blocked: boolean }>(
        `select exists (
           select 1 from market_collection_runs
           where payload->>'sourceId' = $1
             and payload->>'errorCode' in ('PROVIDER_AUTH_FAILED', 'PROVIDER_ACCESS_DENIED', 'PROVIDER_CHALLENGE')
         ) as blocked`,
        [sourceId],
      );
      return result.rows[0]?.blocked ?? false;
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
    async findSettings(targetId) {
      const result = await pool.query<{ payload: unknown }>(
        'select payload from market_collection_settings where target_id = $1',
        [targetId],
      );
      return result.rows[0]
        ? marketCollectionSettingsSchema.parse(result.rows[0].payload)
        : null;
    },
    async listSettings() {
      const result = await pool.query<{ payload: unknown }>(
        'select payload from market_collection_settings order by target_id',
      );
      return result.rows.map((row) =>
        marketCollectionSettingsSchema.parse(row.payload),
      );
    },
    async saveSettings(settings: MarketCollectionSettings) {
      const parsed = marketCollectionSettingsSchema.parse(settings);
      const result = await pool.query<{ payload: unknown }>(
        `insert into market_collection_settings
          (target_id, enabled, paused, interval_minutes, next_run_at, updated_at, payload)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb)
         on conflict (target_id) do update set
           enabled = excluded.enabled,
           paused = excluded.paused,
           interval_minutes = excluded.interval_minutes,
           next_run_at = excluded.next_run_at,
           updated_at = excluded.updated_at,
           payload = excluded.payload
         returning payload`,
        [
          parsed.targetId,
          parsed.enabled,
          parsed.paused,
          parsed.intervalMinutes,
          parsed.nextRunAt,
          parsed.updatedAt,
          JSON.stringify(parsed),
        ],
      );
      return marketCollectionSettingsSchema.parse(result.rows[0]?.payload);
    },
    async claimScheduledSettings(
      settings: MarketCollectionSettings,
      dueAt: string,
    ) {
      const parsed = marketCollectionSettingsSchema.parse(settings);
      const result = await pool.query(
        `update market_collection_settings
         set next_run_at = $3::timestamptz, updated_at = $4::timestamptz,
             payload = jsonb_set(
               jsonb_set(payload, '{nextRunAt}', to_jsonb($3::text), true),
               '{updatedAt}', to_jsonb($4::text), true
             )
         where target_id = $1 and enabled and not paused
           and next_run_at = $2::timestamptz and next_run_at <= $4::timestamptz
         returning target_id`,
        [parsed.targetId, dueAt, parsed.nextRunAt, parsed.updatedAt],
      );
      return result.rowCount === 1;
    },
    async findRun(id) {
      const result = await pool.query<{ payload: unknown }>(
        'select payload from market_collection_runs where id = $1',
        [id],
      );
      return result.rows[0]
        ? marketCollectionRunSchema.parse(result.rows[0].payload)
        : null;
    },
    async listRuns(targetId, limit) {
      const result = await pool.query<{ payload: unknown }>(
        `select payload from market_collection_runs
         where target_id = $1 order by started_at desc, id desc${limit === undefined ? '' : ' limit $2'}`,
        limit === undefined ? [targetId] : [targetId, limit],
      );
      return result.rows.map((row) =>
        marketCollectionRunSchema.parse(row.payload),
      );
    },
    async listObservations(targetId) {
      const result = await pool.query<{
        observation: MarketCollectionObservation;
      }>(
        `select jsonb_build_object(
           'id', payload->'id',
           'targetId', payload->'targetId',
           'targetDigest', payload->'targetDigest',
           'queryDigest', payload->'queryDigest',
           'dataKind', payload->'dataKind',
           'league', payload->'league',
           'patch', payload->'patch',
           'status', payload->'status',
           'coverage', payload->'coverage',
           'inexact', coalesce(payload->'inexact', 'false'::jsonb),
           'currency', payload->'currency',
           'startedAt', payload->'startedAt',
           'capturedAt', payload->'capturedAt',
           'cached', payload->'cached',
           'listings', coalesce((
             select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'externalId', listing->'externalId',
               'currency', listing->'currency',
               'fingerprint', listing->'fingerprint'
             )) || jsonb_build_object('price', listing->'price'))
             from jsonb_array_elements(payload->'listings') listing
           ), '[]'::jsonb)
         ) as observation
         from market_collection_runs where target_id = $1
         order by started_at, id`,
        [targetId],
      );
      return result.rows.map((row) => row.observation);
    },
    async saveRun(run: MarketCollectionRun) {
      const parsed = marketCollectionRunSchema.parse({
        ...run,
        snapshotId: null,
      });
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await client.query<{ payload: unknown }>(
          `insert into market_collection_runs
            (id, target_id, target_digest, league, patch, status, trigger, started_at, heartbeat_at, completed_at, payload)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10::jsonb)
           on conflict (id) do update set
             status = case
               when market_collection_runs.payload->>'cancelRequested' = 'true'
                 and excluded.status <> 'cancelled' then 'cancelled'
               else excluded.status
             end,
             completed_at = case
               when market_collection_runs.payload->>'cancelRequested' = 'true'
                 and excluded.status <> 'cancelled' then coalesce(excluded.completed_at, now())
               else excluded.completed_at
             end,
             payload = case
               when market_collection_runs.payload->>'cancelRequested' = 'true'
                 then
                 jsonb_set(
                   jsonb_set(
                     jsonb_set(excluded.payload, '{cancelRequested}', 'true'::jsonb),
                     '{status}', '"cancelled"'::jsonb
                   ),
                   '{coverage}', '"partial"'::jsonb
                 )
                 || jsonb_build_object('completedAt', to_char(
                   coalesce(excluded.completed_at, now()) at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                 ))
               else excluded.payload
             end
           where market_collection_runs.status = 'running'
           returning payload`,
          [
            parsed.id,
            parsed.targetId,
            parsed.targetDigest,
            parsed.league,
            parsed.patch,
            parsed.status,
            parsed.trigger,
            parsed.startedAt,
            parsed.completedAt,
            JSON.stringify(parsed),
          ],
        );
        if (!result.rows[0]) {
          const existing = await client.query<{ payload: unknown }>(
            'select payload from market_collection_runs where id = $1',
            [parsed.id],
          );
          if (!existing.rows[0])
            throw new Error('Market collection run was not persisted');
          await client.query('commit');
          return marketCollectionRunSchema.parse(existing.rows[0].payload);
        }
        let persisted = marketCollectionRunSchema.parse(result.rows[0].payload);
        if (
          persisted.status !== 'running' &&
          !persisted.cached &&
          persisted.sourceUrl &&
          persisted.capturedAt &&
          persisted.currency &&
          (persisted.listings.length > 0 || persisted.status === 'empty')
        ) {
          // Keep the terminal raw run if projection fails; publish snapshot and link together.
          await client.query('savepoint collection_publication');
          try {
            const targetResult = await client.query<{ profile: unknown }>(
              'select profile from market_targets where id = $1',
              [persisted.targetId],
            );
            const target = marketTargetSchema.parse(
              targetResult.rows[0]?.profile,
            );
            if (
              target.digest !== persisted.targetDigest ||
              target.league !== persisted.league ||
              target.patch !== persisted.patch
            )
              throw new Error('Collection profile scope changed');
            const imported = createImportedMarketSnapshot(
              {
                targetId: target.id,
                capturedAt: persisted.capturedAt,
                sourceUrl: persisted.sourceUrl,
                currency: persisted.currency,
                dataKind: persisted.dataKind,
                notes: `Collection ${persisted.sourceId}; coverage=${persisted.coverage}; inexact=${persisted.inexact ?? false}. Asking prices, not confirmed sales.`,
                emptyResult: persisted.listings.length === 0,
                listings: persisted.listings.map((listing) =>
                  marketImportListingSchema.strip().parse(listing),
                ),
              },
              target,
              new Date(persisted.completedAt ?? persisted.startedAt),
            );
            const snapshot = await insertMarketResearchSnapshot(client, {
              ...imported,
              provenance: 'collection',
              coverage: persisted.coverage ?? 'unknown',
              inexact: persisted.inexact ?? false,
              queryDigest: persisted.queryDigest,
              digest: marketDigest({
                snapshotDigest: imported.digest,
                provenance: 'collection',
                queryDigest: persisted.queryDigest,
              }),
            });
            persisted = { ...persisted, snapshotId: snapshot.id };
            await client.query(
              'update market_collection_runs set payload = $2::jsonb where id = $1',
              [persisted.id, JSON.stringify(persisted)],
            );
            await client.query('release savepoint collection_publication');
          } catch {
            await client.query('rollback to savepoint collection_publication');
            persisted = {
              ...persisted,
              status: persisted.status === 'blocked' ? 'blocked' : 'failed',
              errorCode:
                persisted.status === 'blocked'
                  ? persisted.errorCode
                  : 'MARKET_COLLECTION_PUBLICATION_FAILED',
              snapshotId: null,
            };
            await client.query(
              'update market_collection_runs set status = $3, payload = $2::jsonb where id = $1',
              [persisted.id, JSON.stringify(persisted), persisted.status],
            );
          }
        }
        await client.query('commit');
        return persisted;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        if (
          error &&
          typeof error === 'object' &&
          'constraint' in error &&
          error.constraint === 'market_collection_runs_single_active_uq'
        )
          throw new DomainError('MARKET_COLLECTION_BUSY', { cause: error });
        throw error;
      } finally {
        client.release();
      }
    },
    async requestCancel(runId) {
      const result = await pool.query<{ payload: unknown }>(
        `update market_collection_runs
         set payload = jsonb_set(payload, '{cancelRequested}', 'true'::jsonb)
         where id = $1 and status = 'running'
         returning payload`,
        [runId],
      );
      return result.rows[0]
        ? marketCollectionRunSchema.parse(result.rows[0].payload)
        : null;
    },
    async recoverRunningRuns(at, activeRunIds = []) {
      if (activeRunIds.length > 0)
        await pool.query(
          `update market_collection_runs set heartbeat_at = $1::timestamptz
           where status = 'running' and id = any($2::uuid[])`,
          [at, activeRunIds],
        );
      const cancelled =
        activeRunIds.length === 0
          ? { rows: [] as { id: string }[] }
          : await pool.query<{ id: string }>(
              `select id::text from market_collection_runs
               where status = 'running' and id = any($1::uuid[])
                 and payload->>'cancelRequested' = 'true'`,
              [activeRunIds],
            );
      // shortcut: 30-minute heartbeat grace; shorten only if manager polling changes.
      await pool.query(
        `update market_collection_runs
         set status = 'failed', completed_at = $1::timestamptz,
             payload = jsonb_set(
               jsonb_set(
                 jsonb_set(payload, '{status}', '"failed"'::jsonb),
                 '{completedAt}', to_jsonb(to_char(
                   $1::timestamptz at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                 ))
               ),
               '{errorCode}', '"MARKET_COLLECTION_INTERRUPTED"'::jsonb
             )
         where status = 'running'
           and heartbeat_at < $1::timestamptz - interval '30 minutes'
           and not (id = any($2::uuid[]))`,
        [at, activeRunIds],
      );
      return cancelled.rows.map((row) => row.id);
    },
  };
}
