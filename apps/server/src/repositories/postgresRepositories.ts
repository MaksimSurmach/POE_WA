import type {
  AggregatedObservation,
  Job,
  MarketQuery,
  RawSnapshot,
  Recipe,
  RecipeEvaluation,
  RefreshCycle,
  Repositories,
} from '@poe-worksmith/domain';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import {
  aggregatedObservations,
  catalogState,
  jobs,
  marketQueries,
  rawSnapshots,
  recipeEvaluations,
  recipes,
  refreshCycles,
} from '../schema.js';
import {
  mapRepositoryError,
  RepositoryConflictError,
  RepositoryNotFoundError,
} from './errors.js';

type RecipeRow = typeof recipes.$inferSelect;
type MarketQueryRow = typeof marketQueries.$inferSelect;
type SnapshotRow = typeof rawSnapshots.$inferSelect;
type ObservationRow = typeof aggregatedObservations.$inferSelect;
type EvaluationRow = typeof recipeEvaluations.$inferSelect;
type CycleRow = typeof refreshCycles.$inferSelect;
type JobRow = typeof jobs.$inferSelect;

export function createPostgresRepositories(pool: Pool): Repositories {
  const database = drizzle({ client: pool });

  return {
    recipes: {
      findById(id) {
        return mapRepositoryError('recipes', 'findById', async () => {
          const [row] = await database
            .select()
            .from(recipes)
            .where(eq(recipes.id, id))
            .limit(1);
          return row ? mapRecipe(row) : null;
        });
      },
      listActive() {
        return mapRepositoryError('recipes', 'listActive', async () => {
          const rows = await database
            .select()
            .from(recipes)
            .where(eq(recipes.active, true))
            .orderBy(recipes.title);
          return rows.map(mapRecipe);
        });
      },
      save(recipe) {
        return mapRepositoryError('recipes', 'save', async () => {
          const [row] = await database
            .insert(recipes)
            .values(recipeValues(recipe))
            .onConflictDoUpdate({
              set: { ...recipeValues(recipe), updatedAt: new Date() },
              target: recipes.id,
            })
            .returning();
          if (!row) throw new RepositoryNotFoundError('recipes', 'save');
          return mapRecipe(row);
        });
      },
    },
    marketQueries: {
      findByCanonicalHash(canonicalHash) {
        return mapRepositoryError(
          'marketQueries',
          'findByCanonicalHash',
          async () => {
            const [row] = await database
              .select()
              .from(marketQueries)
              .where(eq(marketQueries.canonicalHash, canonicalHash))
              .limit(1);
            return row ? mapMarketQuery(row) : null;
          },
        );
      },
      save(query) {
        return mapRepositoryError('marketQueries', 'save', async () => {
          const [row] = await database
            .insert(marketQueries)
            .values(marketQueryValues(query))
            .onConflictDoUpdate({
              set: {
                active: query.active,
                provider: query.provider,
                query: { ...query.query },
                recipeId: query.recipeId,
                updatedAt: new Date(),
              },
              target: marketQueries.canonicalHash,
            })
            .returning();
          if (!row) {
            throw new RepositoryNotFoundError('marketQueries', 'save');
          }
          return mapMarketQuery(row);
        });
      },
    },
    snapshots: {
      deleteExpired(before) {
        return mapRepositoryError('snapshots', 'deleteExpired', async () => {
          const deleted = await database
            .delete(rawSnapshots)
            .where(lte(rawSnapshots.expiresAt, before))
            .returning({ id: rawSnapshots.id });
          return deleted.length;
        });
      },
      findLatest(marketQueryId) {
        return mapRepositoryError('snapshots', 'findLatest', async () => {
          const [row] = await database
            .select()
            .from(rawSnapshots)
            .where(eq(rawSnapshots.marketQueryId, marketQueryId))
            .orderBy(desc(rawSnapshots.capturedAt))
            .limit(1);
          return row ? mapSnapshot(row) : null;
        });
      },
      save(snapshot) {
        return mapRepositoryError('snapshots', 'save', async () => {
          const [inserted] = await database
            .insert(rawSnapshots)
            .values({ ...snapshot, payload: { ...snapshot.payload } })
            .onConflictDoNothing({ target: rawSnapshots.dedupeKey })
            .returning();
          if (inserted) {
            return { inserted: true, snapshot: mapSnapshot(inserted) };
          }

          const [existing] = await database
            .select()
            .from(rawSnapshots)
            .where(eq(rawSnapshots.dedupeKey, snapshot.dedupeKey))
            .limit(1);
          if (!existing) {
            throw new RepositoryNotFoundError('snapshots', 'save');
          }
          return { inserted: false, snapshot: mapSnapshot(existing) };
        });
      },
    },
    observations: {
      listRecent(marketQueryId, since) {
        return mapRepositoryError('observations', 'listRecent', async () => {
          const rows = await database
            .select()
            .from(aggregatedObservations)
            .where(
              and(
                eq(aggregatedObservations.marketQueryId, marketQueryId),
                gte(aggregatedObservations.observedAt, since),
              ),
            )
            .orderBy(desc(aggregatedObservations.observedAt));
          return rows.map(mapObservation);
        });
      },
      save(observation) {
        return mapRepositoryError('observations', 'save', async () => {
          const values = {
            ...observation,
            summary: { ...observation.summary },
          };
          const [row] = await database
            .insert(aggregatedObservations)
            .values(values)
            .onConflictDoUpdate({
              set: { ...values, updatedAt: new Date() },
              target: [
                aggregatedObservations.marketQueryId,
                aggregatedObservations.refreshCycleId,
              ],
            })
            .returning();
          if (!row) {
            throw new RepositoryNotFoundError('observations', 'save');
          }
          return mapObservation(row);
        });
      },
    },
    evaluations: {
      findByRecipeAndCycle(recipeId, refreshCycleId) {
        return mapRepositoryError(
          'evaluations',
          'findByRecipeAndCycle',
          async () => {
            const [row] = await database
              .select()
              .from(recipeEvaluations)
              .where(
                and(
                  eq(recipeEvaluations.recipeId, recipeId),
                  eq(recipeEvaluations.refreshCycleId, refreshCycleId),
                ),
              )
              .limit(1);
            return row ? mapEvaluation(row) : null;
          },
        );
      },
      listByCycle(refreshCycleId) {
        return mapRepositoryError('evaluations', 'listByCycle', async () => {
          const rows = await database
            .select()
            .from(recipeEvaluations)
            .where(eq(recipeEvaluations.refreshCycleId, refreshCycleId))
            .orderBy(recipeEvaluations.recipeId);
          return rows.map(mapEvaluation);
        });
      },
      save(evaluation) {
        return mapRepositoryError('evaluations', 'save', async () => {
          const [row] = await database
            .insert(recipeEvaluations)
            .values(evaluation)
            .onConflictDoUpdate({
              set: { ...evaluation, updatedAt: new Date() },
              target: [
                recipeEvaluations.recipeId,
                recipeEvaluations.refreshCycleId,
              ],
            })
            .returning();
          if (!row) {
            throw new RepositoryNotFoundError('evaluations', 'save');
          }
          return mapEvaluation(row);
        });
      },
    },
    cycles: {
      findById(id) {
        return mapRepositoryError('cycles', 'findById', async () => {
          const [row] = await database
            .select()
            .from(refreshCycles)
            .where(eq(refreshCycles.id, id))
            .limit(1);
          return row ? mapCycle(row) : null;
        });
      },
      getPublishedCycleId() {
        return mapRepositoryError('cycles', 'getPublishedCycleId', async () => {
          const [row] = await database
            .select({ publishedCycleId: catalogState.publishedCycleId })
            .from(catalogState)
            .where(eq(catalogState.id, 1))
            .limit(1);
          return row?.publishedCycleId ?? null;
        });
      },
      publish(id, publishedAt) {
        return mapRepositoryError('cycles', 'publish', async () => {
          const client = await pool.connect();
          try {
            await client.query('begin');
            const candidate = await client.query<{
              completed_recipes: number;
              failed_recipes: number;
              status: string;
              total_recipes: number;
            }>(
              `select status, total_recipes, completed_recipes, failed_recipes
               from refresh_cycles
               where id = $1
               for update`,
              [id],
            );
            const row = candidate.rows[0];
            if (!row) throw new RepositoryNotFoundError('cycles', 'publish');
            if (
              row.status !== 'running' ||
              row.completed_recipes + row.failed_recipes !== row.total_recipes
            ) {
              throw new RepositoryConflictError('cycles', 'publish');
            }

            const state = await client.query<{
              published_cycle_id: string | null;
            }>(
              `select published_cycle_id
               from catalog_state
               where id = 1
               for update`,
            );
            const previousCycleId = state.rows[0]?.published_cycle_id ?? null;

            if (previousCycleId && previousCycleId !== id) {
              await client.query(
                `update refresh_cycles
                 set status = 'superseded', updated_at = $2
                 where id = $1`,
                [previousCycleId, publishedAt],
              );
            }
            await client.query(
              `update refresh_cycles
               set status = 'published', published_at = $2, finished_at = $2, updated_at = $2
               where id = $1`,
              [id, publishedAt],
            );
            await client.query(
              `insert into catalog_state
                 (id, published_cycle_id, previous_cycle_id, revision, published_at, updated_at)
               values (1, $1, $2, 1, $3, $3)
               on conflict (id) do update
               set published_cycle_id = excluded.published_cycle_id,
                   previous_cycle_id = catalog_state.published_cycle_id,
                   revision = catalog_state.revision + 1,
                   published_at = excluded.published_at,
                   updated_at = excluded.updated_at`,
              [id, previousCycleId, publishedAt],
            );
            await client.query('commit');
          } catch (error) {
            await client.query('rollback').catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        });
      },
      save(cycle) {
        return mapRepositoryError('cycles', 'save', async () => {
          const [row] = await database
            .insert(refreshCycles)
            .values(cycleValues(cycle))
            .onConflictDoUpdate({
              set: { ...cycleValues(cycle), updatedAt: new Date() },
              target: refreshCycles.id,
            })
            .returning();
          if (!row) throw new RepositoryNotFoundError('cycles', 'save');
          return mapCycle(row);
        });
      },
    },
    jobs: {
      claimNext(workerId, now) {
        return mapRepositoryError('jobs', 'claimNext', async () => {
          const result = await pool.query<JobRow>(
            `update jobs
             set status = 'running',
                 attempts = attempts + 1,
                 locked_at = $2,
                 locked_by = $1,
                 updated_at = $2
             where id = (
               select id
               from jobs
               where status in ('queued', 'retry')
                 and run_after <= $2
                 and attempts < max_attempts
               order by priority desc, run_after, created_at
               for update skip locked
               limit 1
             )
             returning id,
                       dedupe_key as "dedupeKey",
                       kind,
                       status,
                       priority,
                       attempts,
                       max_attempts as "maxAttempts",
                       refresh_cycle_id as "refreshCycleId",
                       recipe_id as "recipeId",
                       market_query_id as "marketQueryId",
                       run_after as "runAfter",
                       locked_at as "lockedAt",
                       locked_by as "lockedBy",
                       last_error as "lastError",
                       payload,
                       created_at as "createdAt",
                       updated_at as "updatedAt"`,
            [workerId, now],
          );
          const row = result.rows[0];
          return row ? mapJob(row) : null;
        });
      },
      complete(id, completedAt) {
        return mapRepositoryError('jobs', 'complete', async () => {
          const result = await pool.query(
            `update jobs
             set status = 'succeeded', locked_at = null, locked_by = null,
                 last_error = null, updated_at = $2
             where id = $1 and status = 'running'
             returning id`,
            [id, completedAt],
          );
          if (!result.rowCount) {
            throw new RepositoryNotFoundError('jobs', 'complete');
          }
        });
      },
      enqueue(job) {
        return mapRepositoryError('jobs', 'enqueue', async () => {
          const [inserted] = await database
            .insert(jobs)
            .values(jobValues(job))
            .onConflictDoNothing({ target: jobs.dedupeKey })
            .returning();
          if (inserted) return mapJob(inserted);

          const [existing] = await database
            .select()
            .from(jobs)
            .where(eq(jobs.dedupeKey, job.dedupeKey))
            .limit(1);
          if (!existing) throw new RepositoryNotFoundError('jobs', 'enqueue');
          return mapJob(existing);
        });
      },
      fail(id, error, retryAt, now) {
        return mapRepositoryError('jobs', 'fail', async () => {
          const result = await pool.query(
            `update jobs
             set status = case when attempts < max_attempts then 'retry' else 'failed' end,
                 run_after = $3,
                 locked_at = null,
                 locked_by = null,
                 last_error = $2,
                 updated_at = $4
             where id = $1 and status = 'running'
             returning id`,
            [id, error, retryAt, now],
          );
          if (!result.rowCount) {
            throw new RepositoryNotFoundError('jobs', 'fail');
          }
        });
      },
    },
  };
}

function recipeValues(recipe: Recipe) {
  return {
    ...recipe,
    definition: { ...recipe.definition },
    tags: [...recipe.tags],
  };
}

function marketQueryValues(query: MarketQuery) {
  return { ...query, query: { ...query.query } };
}

function cycleValues(cycle: RefreshCycle) {
  return { ...cycle };
}

function jobValues(job: Job) {
  return { ...job, payload: { ...job.payload } };
}

function mapRecipe(row: RecipeRow): Recipe {
  return { ...row, definition: row.definition, tags: row.tags };
}

function mapMarketQuery(row: MarketQueryRow): MarketQuery {
  return { ...row, query: row.query };
}

function mapSnapshot(row: SnapshotRow): RawSnapshot {
  return { ...row, payload: row.payload };
}

function mapObservation(row: ObservationRow): AggregatedObservation {
  return { ...row, summary: row.summary };
}

function mapEvaluation(row: EvaluationRow): RecipeEvaluation {
  return {
    ...row,
    confidence: row.confidence as RecipeEvaluation['confidence'],
    status: row.status as RecipeEvaluation['status'],
  };
}

function mapCycle(row: CycleRow): RefreshCycle {
  return { ...row, status: row.status as RefreshCycle['status'] };
}

function mapJob(row: JobRow): Job {
  return {
    ...row,
    kind: row.kind as Job['kind'],
    payload: row.payload,
    status: row.status as Job['status'],
  };
}
