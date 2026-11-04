import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { DomainError, type RiskSimulationRequest } from '@poe-worksmith/domain';
import {
  craftModelRecordSchema,
  craftRiskRunSchema,
  type CraftModelRecord,
  type CraftModelSaveInput,
  type CraftRiskRun,
} from '@poe-worksmith/contracts';
import { canonicalMarketJson } from '../marketResearch.js';

export function craftRequestHash(value: unknown) {
  return createHash('sha256').update(canonicalMarketJson(value)).digest('hex');
}

type ModelRow = {
  id: string;
  recipe_id: string;
  recipe_content_hash: string;
  target_signature: string;
  league_id: string;
  revision: number;
  document: Record<string, unknown>;
  created_at: Date;
  request_hash: string;
};
type RunRow = {
  id: string;
  model_id: string;
  recipe_id: string;
  recipe_content_hash: string;
  league_id: string;
  calculation_version: string;
  request_hash: string;
  request: RiskSimulationRequest;
  status: CraftRiskRun['status'];
  progress: number;
  result: CraftRiskRun['result'];
  error: string | null;
  cancel_requested: boolean;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};
function modelRecord(row: ModelRow): CraftModelRecord {
  return craftModelRecordSchema.parse({
    ...row.document,
    id: row.id,
    recipeId: row.recipe_id,
    recipeHash: row.recipe_content_hash,
    targetSignature: row.target_signature,
    leagueId: row.league_id,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
  });
}
function runRecord(row: RunRow): CraftRiskRun {
  return craftRiskRunSchema.parse({
    id: row.id,
    modelId: row.model_id,
    recipeId: row.recipe_id,
    recipeHash: row.recipe_content_hash,
    leagueId: row.league_id,
    calculationVersion: row.calculation_version,
    request: row.request,
    status: row.status,
    progress: row.progress,
    result: row.result,
    error: row.error,
    cancelRequested: row.cancel_requested,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  });
}
function conflict(error: unknown): never {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '23505'
  )
    throw new DomainError('PERSISTENCE_CONFLICT');
  throw error;
}

export function createCraftAnalysisRepository(pool: Pool) {
  const findRun = async (id: string): Promise<CraftRiskRun | null> => {
    const result = await pool.query<RunRow>(
      'select * from craft_risk_runs where id=$1',
      [id],
    );
    return result.rows[0] ? runRecord(result.rows[0]) : null;
  };
  return {
    async latestModel(recipeId: string, recipeHash: string, leagueId: string) {
      const result = await pool.query<ModelRow>(
        `select * from craft_outcome_models where recipe_id=$1 and recipe_content_hash=$2 and league_id=$3 order by revision desc limit 1`,
        [recipeId, recipeHash, leagueId],
      );
      return result.rows[0] ? modelRecord(result.rows[0]) : null;
    },
    async findModel(id: string) {
      const result = await pool.query<ModelRow>(
        'select * from craft_outcome_models where id=$1',
        [id],
      );
      return result.rows[0] ? modelRecord(result.rows[0]) : null;
    },
    async saveModel(
      input: CraftModelSaveInput,
      context: { leagueId: string; targetSignature: string },
    ): Promise<CraftModelRecord> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          'select pg_advisory_xact_lock(hashtextextended($1,0))',
          [
            `craft-model:${input.recipeId}:${input.recipeHash}:${context.leagueId}`,
          ],
        );
        const requestHash = craftRequestHash({ input, context });
        const prior = await client.query<ModelRow>(
          'select * from craft_outcome_models where idempotency_key=$1',
          [input.idempotencyKey],
        );
        if (prior.rows[0]) {
          if (prior.rows[0].request_hash !== requestHash)
            throw new DomainError('PERSISTENCE_CONFLICT');
          await client.query('commit');
          return modelRecord(prior.rows[0]);
        }
        const latest = await client.query<{ revision: number }>(
          'select revision from craft_outcome_models where recipe_id=$1 and recipe_content_hash=$2 and league_id=$3 order by revision desc limit 1',
          [input.recipeId, input.recipeHash, context.leagueId],
        );
        if ((latest.rows[0]?.revision ?? null) !== input.expectedRevision)
          throw new DomainError('PERSISTENCE_CONFLICT');
        const { idempotencyKey, expectedRevision, ...document } = input;
        const result = await client.query<ModelRow>(
          `insert into craft_outcome_models(id,recipe_id,recipe_content_hash,target_signature,league_id,revision,idempotency_key,request_hash,document)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
          [
            randomUUID(),
            input.recipeId,
            input.recipeHash,
            context.targetSignature,
            context.leagueId,
            (expectedRevision ?? 0) + 1,
            idempotencyKey,
            requestHash,
            document,
          ],
        );
        await client.query('commit');
        return modelRecord(result.rows[0]!);
      } catch (error) {
        await client.query('rollback');
        conflict(error);
      } finally {
        client.release();
      }
    },
    async findIdempotentRun(idempotencyKey: string, requestHash: string) {
      const result = await pool.query<RunRow>(
        'select * from craft_risk_runs where idempotency_key=$1',
        [idempotencyKey],
      );
      if (!result.rows[0]) return null;
      if (result.rows[0].request_hash !== requestHash)
        throw new DomainError('PERSISTENCE_CONFLICT');
      return runRecord(result.rows[0]);
    },
    async createRun(input: {
      model: CraftModelRecord;
      idempotencyKey: string;
      requestHash: string;
      calculationVersion: string;
      request: RiskSimulationRequest;
    }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended('craft-risk-queue',0))",
        );
        const prior = await client.query<RunRow>(
          'select * from craft_risk_runs where idempotency_key=$1',
          [input.idempotencyKey],
        );
        if (prior.rows[0]) {
          if (prior.rows[0].request_hash !== input.requestHash)
            throw new DomainError('PERSISTENCE_CONFLICT');
          await client.query('commit');
          return runRecord(prior.rows[0]);
        }
        const count = await client.query<{ count: string }>(
          "select count(*) from craft_risk_runs where status in ('queued','running')",
        );
        if (Number(count.rows[0]?.count) >= 20)
          throw new DomainError('JOB_CONFLICT');
        const result = await client.query<RunRow>(
          `insert into craft_risk_runs(id,model_id,recipe_id,recipe_content_hash,league_id,calculation_version,idempotency_key,request_hash,request,status)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued') returning *`,
          [
            randomUUID(),
            input.model.id,
            input.model.recipeId,
            input.model.recipeHash,
            input.model.leagueId,
            input.calculationVersion,
            input.idempotencyKey,
            input.requestHash,
            input.request,
          ],
        );
        await client.query('commit');
        return runRecord(result.rows[0]!);
      } catch (error) {
        await client.query('rollback');
        conflict(error);
      } finally {
        client.release();
      }
    },
    findRun,
    async cancelRun(id: string) {
      await pool.query(
        `update craft_risk_runs set cancel_requested=true,
         status=case when status='queued' then 'cancelled' else status end,
         finished_at=case when status='queued' then now() else finished_at end
         where id=$1 and status in ('queued','running')`,
        [id],
      );
      return findRun(id);
    },
    async withWorker(
      work: (
        worker: {
          claim(): Promise<CraftRiskRun | null>;
          progress(id: string, percent: number): Promise<boolean>;
          finish(
            id: string,
            status: 'completed' | 'failed' | 'cancelled' | 'interrupted',
            result: CraftRiskRun['result'],
            error: string | null,
          ): Promise<void>;
        },
        disconnected: AbortSignal,
      ) => Promise<void>,
    ): Promise<boolean> {
      const client = await pool.connect();
      let locked = false;
      const disconnected = new AbortController();
      const onError = () => disconnected.abort();
      client.on('error', onError);
      try {
        const acquired = await client.query<{ locked: boolean }>(
          "select pg_try_advisory_lock(hashtextextended('craft-risk-worker',0)) as locked",
        );
        locked = acquired.rows[0]?.locked === true;
        if (!locked) return false;
        await client.query(
          "update craft_risk_runs set status=case when cancel_requested then 'cancelled' else 'interrupted' end, finished_at=now(), error='Worker interrupted before result was saved' where status='running'",
        );
        await work(
          {
            async claim() {
              const result = await client.query<RunRow>(
                `update craft_risk_runs set status='running',started_at=now()
               where id=(select id from craft_risk_runs where status='queued' order by created_at,id limit 1 for update skip locked) returning *`,
              );
              return result.rows[0] ? runRecord(result.rows[0]) : null;
            },
            async progress(id, percent) {
              const result = await client.query<{ cancel_requested: boolean }>(
                "update craft_risk_runs set progress=$2 where id=$1 and status='running' returning cancel_requested",
                [id, percent],
              );
              return !result.rows[0] || result.rows[0].cancel_requested;
            },
            async finish(id, status, result, error) {
              await client.query(
                `update craft_risk_runs set status=case when cancel_requested then 'cancelled' else $2 end,
               result=case when cancel_requested then null else $3::jsonb end,
               progress=case when $2='completed' and not cancel_requested then 100 else progress end,
               error=$4,finished_at=now() where id=$1 and status='running'`,
                [id, status, result, error],
              );
            },
          },
          disconnected.signal,
        );
        return true;
      } finally {
        client.off('error', onError);
        if (locked && !disconnected.signal.aborted)
          await client
            .query(
              "select pg_advisory_unlock(hashtextextended('craft-risk-worker',0))",
            )
            .catch(() => {});
        client.release(disconnected.signal.aborted);
      }
    },
    async readValuationCandidates(leagueId: string) {
      const result = await pool.query<{
        recipe_id: string;
        recipe_content_hash: string;
        target_signature: string;
        currency: string | null;
        estimated_sale_price: string | null;
        method_cost: Record<string, unknown> | null;
        evaluated_at: Date;
        source_snapshot_dedupe_key: string | null;
      }>(
        `select distinct on (e.recipe_id) e.recipe_id,r.content_hash as recipe_content_hash,r.definition->>'targetSignature' as target_signature,
         e.currency,e.estimated_sale_price,e.method_cost,e.evaluated_at,e.source_snapshot_dedupe_key
         from recipe_evaluations e join recipes r on r.id=e.recipe_id
         where e.league_id=$1 and e.status in ('success','partial') and e.method_cost->>'recipeContentHash'=r.content_hash
         order by e.recipe_id,e.evaluated_at desc,e.id desc`,
        [leagueId],
      );
      return result.rows;
    },
  };
}
export type CraftAnalysisRepository = ReturnType<
  typeof createCraftAnalysisRepository
>;
