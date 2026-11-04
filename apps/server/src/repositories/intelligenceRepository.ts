import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DomainError } from '@poe-worksmith/domain';
import { craftRiskRunSchema } from '@poe-worksmith/contracts';
import { createCraftAnalysisRepository } from './craftAnalysisRepository.js';

export function createIntelligenceRepository(pool: Pool) {
  async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const value = await work(client);
      await client.query('commit');
      return value;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    async snapshots(queryHash: string, leagueId: string) {
      const result = await pool.query<{
        dedupe_key: string;
        captured_at: Date;
        expires_at: Date;
        payload: unknown;
        query: Record<string, unknown>;
        provider_status: number;
      }>(
        `select s.dedupe_key,s.captured_at,s.expires_at,s.payload,q.query,s.provider_status from raw_snapshots s join market_queries q on q.id=s.market_query_id where q.canonical_hash=$1 and s.league_id=$2 order by s.captured_at desc,s.id desc limit 3`,
        [queryHash, leagueId],
      );
      return result.rows;
    },
    async risks(
      recipeId: string,
      recipeHash: string,
      leagueId: string,
      modelId: string,
    ) {
      const ids = await pool.query<{ id: string }>(
        `select id from craft_risk_runs where recipe_id=$1 and recipe_content_hash=$2 and league_id=$3 and model_id=$4 and status='completed' and result->>'status'='complete' order by finished_at desc,id limit 20`,
        [recipeId, recipeHash, leagueId, modelId],
      );
      const repository = createCraftAnalysisRepository(pool);
      const runs = [];
      for (const row of ids.rows) {
        const run = await repository.findRun(row.id);
        if (run) runs.push(craftRiskRunSchema.parse(run));
      }
      return runs;
    },
    async state(contextKey: string) {
      const result = await pool.query<{ document: unknown }>(
        'select document from craft_signal_states where context_key=$1',
        [contextKey],
      );
      return result.rows[0]?.document ?? null;
    },
    async updateSignal<T>(
      context: {
        key: string;
        recipeId: string;
        recipeHash: string;
        leagueId: string;
        targetSignature: string;
      },
      decide: (previous: unknown) => {
        document: T;
        emit: boolean;
        evidenceHash: string;
      },
    ) {
      return transaction(async (client) => {
        await client.query(
          'select pg_advisory_xact_lock(hashtextextended($1,0))',
          [`intelligence:${context.key}`],
        );
        const previous = await client.query<{ document: unknown }>(
          'select document from craft_signal_states where context_key=$1',
          [context.key],
        );
        const next = decide(previous.rows[0]?.document ?? null);
        await client.query(
          `insert into craft_signal_states(context_key,recipe_id,recipe_content_hash,league_id,target_signature,document) values($1,$2,$3,$4,$5,$6) on conflict(context_key) do update set document=excluded.document,updated_at=now()`,
          [
            context.key,
            context.recipeId,
            context.recipeHash,
            context.leagueId,
            context.targetSignature,
            next.document,
          ],
        );
        await client.query(
          'insert into craft_signal_history(id,context_key,evidence_hash,document) values($1,$2,$3,$4) on conflict(context_key,evidence_hash) do nothing',
          [randomUUID(), context.key, next.evidenceHash, next.document],
        );
        return next.document;
      });
    },
    async history(contextKey: string) {
      const result = await pool.query<{
        id: string;
        created_at: Date;
        document: unknown;
      }>(
        'select id,created_at,document from craft_signal_history where context_key=$1 order by created_at desc,id limit 30',
        [contextKey],
      );
      return result.rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at.toISOString(),
        document: r.document,
      }));
    },
    async findPlan(id: string) {
      const result = await pool.query<{ document: unknown }>(
        'select document from craft_allocation_plans where id=$1',
        [id],
      );
      return result.rows[0]?.document ?? null;
    },
    async findPlanRetry(key: string, hash: string) {
      const result = await pool.query<{
        request_hash: string;
        document: unknown;
      }>(
        'select request_hash,document from craft_allocation_plans where idempotency_key=$1',
        [key],
      );
      if (!result.rows[0]) return null;
      if (result.rows[0].request_hash !== hash)
        throw new DomainError('PERSISTENCE_CONFLICT');
      return result.rows[0].document;
    },
    async savePlan(input: {
      id: string;
      leagueId: string;
      key: string;
      hash: string;
      document: unknown;
    }) {
      return transaction(async (client) => {
        await client.query(
          'select pg_advisory_xact_lock(hashtextextended($1,0))',
          [`allocation:${input.key}`],
        );
        const previous = await client.query<{
          request_hash: string;
          document: unknown;
        }>(
          'select request_hash,document from craft_allocation_plans where idempotency_key=$1',
          [input.key],
        );
        if (previous.rows[0]) {
          if (previous.rows[0].request_hash !== input.hash)
            throw new DomainError('PERSISTENCE_CONFLICT');
          return previous.rows[0].document;
        }
        await client.query(
          'insert into craft_allocation_plans(id,league_id,idempotency_key,request_hash,document) values($1,$2,$3,$4,$5)',
          [input.id, input.leagueId, input.key, input.hash, input.document],
        );
        return input.document;
      });
    },
    async withRefreshLease(work: () => Promise<void>) {
      const client = await pool.connect();
      let acquired = false;
      let disconnected = false;
      const onError = () => {
        disconnected = true;
      };
      client.on('error', onError);
      try {
        acquired =
          (
            await client.query<{ locked: boolean }>(
              "select pg_try_advisory_lock(hashtextextended('intelligence-refresh',0)) as locked",
            )
          ).rows[0]?.locked === true;
        if (acquired) await work();
      } finally {
        if (acquired && !disconnected)
          await client.query(
            "select pg_advisory_unlock(hashtextextended('intelligence-refresh',0))",
          );
        client.off('error', onError);
        client.release(disconnected);
      }
    },
  };
}
export type IntelligenceRepository = ReturnType<
  typeof createIntelligenceRepository
>;
