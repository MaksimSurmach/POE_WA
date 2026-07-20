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
import {
  assertNewJob,
  assertNewRefreshCycle,
  assertJobTransition,
  assertPublicationReady,
  assertRefreshCycleInvariant,
  assertRefreshTransition,
  assertSnapshotInvariant,
  assertSingleRunningCycle,
} from '@poe-worksmith/domain';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

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
import { mapRepositoryError, RepositoryNotFoundError } from './errors.js';

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
    catalog: {
      getProgress() {
        return mapRepositoryError('catalog', 'getProgress', async () => {
          const client = await pool.connect();
          try {
            await client.query(
              'begin transaction isolation level repeatable read read only',
            );
            const transaction = drizzle({ client });
            const [running] = await transaction
              .select()
              .from(refreshCycles)
              .where(eq(refreshCycles.status, 'running'))
              .orderBy(desc(refreshCycles.requestedAt))
              .limit(1);
            const [queued] = running
              ? []
              : await transaction
                  .select()
                  .from(refreshCycles)
                  .where(eq(refreshCycles.status, 'queued'))
                  .orderBy(desc(refreshCycles.requestedAt))
                  .limit(1);
            const active = running ?? queued;
            const [state] = await transaction
              .select({ publishedCycleId: catalogState.publishedCycleId })
              .from(catalogState)
              .where(eq(catalogState.id, 1))
              .limit(1);
            const [published] = state?.publishedCycleId
              ? await transaction
                  .select()
                  .from(refreshCycles)
                  .where(eq(refreshCycles.id, state.publishedCycleId))
                  .limit(1)
              : [];
            if (state?.publishedCycleId && !published) {
              throw new RepositoryNotFoundError('catalog', 'getProgress');
            }
            await client.query('commit');
            return {
              active: active ? mapCycle(active) : null,
              published: published ? mapCycle(published) : null,
            };
          } catch (error) {
            await client.query('rollback').catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        });
      },
      getPublished() {
        return mapRepositoryError('catalog', 'getPublished', async () => {
          const client = await pool.connect();
          try {
            await client.query(
              'begin transaction isolation level repeatable read read only',
            );
            const transaction = drizzle({ client });
            const [state] = await transaction
              .select({ publishedCycleId: catalogState.publishedCycleId })
              .from(catalogState)
              .where(eq(catalogState.id, 1))
              .limit(1);
            if (!state?.publishedCycleId) {
              await client.query('commit');
              return null;
            }
            const [cycle] = await transaction
              .select()
              .from(refreshCycles)
              .where(eq(refreshCycles.id, state.publishedCycleId))
              .limit(1);
            if (!cycle) {
              throw new RepositoryNotFoundError('catalog', 'getPublished');
            }
            const evaluationRows = await transaction
              .select()
              .from(recipeEvaluations)
              .where(
                eq(recipeEvaluations.refreshCycleId, state.publishedCycleId),
              )
              .orderBy(recipeEvaluations.recipeId);
            const recipeRows =
              evaluationRows.length === 0
                ? []
                : await transaction
                    .select()
                    .from(recipes)
                    .where(
                      inArray(
                        recipes.id,
                        evaluationRows.map(({ recipeId }) => recipeId),
                      ),
                    )
                    .orderBy(recipes.id);
            if (recipeRows.length !== evaluationRows.length) {
              throw new RepositoryNotFoundError('catalog', 'getPublished');
            }
            await client.query('commit');
            return {
              cycle: mapCycle(cycle),
              evaluations: evaluationRows.map(mapEvaluation),
              recipes: recipeRows.map(mapRecipe),
            };
          } catch (error) {
            await client.query('rollback').catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        });
      },
    },
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
      listAll() {
        return mapRepositoryError('recipes', 'listAll', async () => {
          const rows = await database
            .select()
            .from(recipes)
            .orderBy(recipes.id);
          return rows.map(mapRecipe);
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
    marketResults: {
      commitSuccess(result) {
        assertSnapshotInvariant(result.snapshot);
        return mapRepositoryError(
          'marketResults',
          'commitSuccess',
          async () => {
            const client = await pool.connect();
            try {
              await client.query('begin');
              const jobResult = await client.query<{
                market_query_id: string | null;
                refresh_cycle_id: string | null;
                status: string;
              }>(
                `select status, refresh_cycle_id, market_query_id
                 from jobs
                 where id = $1
                 for update`,
                [result.jobId],
              );
              const job = jobResult.rows[0];
              if (!job) {
                throw new RepositoryNotFoundError(
                  'marketResults',
                  'commitSuccess',
                );
              }
              if (job.status === 'succeeded') {
                await client.query('commit');
                return { applied: false };
              }
              assertJobTransition(job.status as Job['status'], 'succeeded');
              if (
                job.refresh_cycle_id !== result.snapshot.refreshCycleId ||
                job.refresh_cycle_id !== result.observation.refreshCycleId ||
                job.market_query_id !== result.snapshot.marketQueryId ||
                job.market_query_id !== result.observation.marketQueryId
              ) {
                throw new Error('Market result does not match its job');
              }

              const cycleResult = await client.query<{
                completed_queries: number;
                failed_queries: number;
                total_queries: number;
              }>(
                `select total_queries, completed_queries, failed_queries
                 from refresh_cycles
                 where id = $1
                 for update`,
                [job.refresh_cycle_id],
              );
              const cycle = cycleResult.rows[0];
              if (!cycle) {
                throw new RepositoryNotFoundError(
                  'marketResults',
                  'commitSuccess',
                );
              }
              if (
                cycle.completed_queries + cycle.failed_queries >=
                cycle.total_queries
              ) {
                throw new Error('Refresh query progress is already complete');
              }

              await client.query(
                `insert into raw_snapshots
                   (dedupe_key, market_query_id, refresh_cycle_id, captured_at,
                    expires_at, provider_status, payload)
                 values ($1, $2, $3, $4, $5, $6, $7)
                 on conflict (dedupe_key) do nothing`,
                [
                  result.snapshot.dedupeKey,
                  result.snapshot.marketQueryId,
                  result.snapshot.refreshCycleId,
                  result.snapshot.capturedAt,
                  result.snapshot.expiresAt,
                  result.snapshot.providerStatus,
                  JSON.stringify(result.snapshot.payload),
                ],
              );
              await client.query(
                `insert into aggregated_observations
                   (market_query_id, refresh_cycle_id, observed_at, sample_size,
                    currency, cheapest_price, nth_price, median_top_n_price, summary)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 on conflict (market_query_id, refresh_cycle_id) do nothing`,
                [
                  result.observation.marketQueryId,
                  result.observation.refreshCycleId,
                  result.observation.observedAt,
                  result.observation.sampleSize,
                  result.observation.currency,
                  result.observation.cheapestPrice,
                  result.observation.nthPrice,
                  result.observation.medianTopNPrice,
                  JSON.stringify(result.observation.summary),
                ],
              );
              await client.query(
                `update refresh_cycles
                 set completed_queries = completed_queries + 1, updated_at = $2
                 where id = $1`,
                [job.refresh_cycle_id, result.completedAt],
              );
              await client.query(
                `update jobs
                 set status = 'succeeded', locked_at = null, locked_by = null,
                     last_error = null, updated_at = $2
                 where id = $1`,
                [result.jobId, result.completedAt],
              );
              await client.query('commit');
              return { applied: true };
            } catch (error) {
              await client.query('rollback').catch(() => undefined);
              throw error;
            } finally {
              client.release();
            }
          },
        );
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
        assertSnapshotInvariant(snapshot);
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
            await client.query(
              `insert into catalog_state (id)
               values (1)
               on conflict (id) do nothing`,
            );
            const state = await client.query<{
              published_cycle_id: string | null;
            }>(
              `select published_cycle_id
               from catalog_state
               where id = 1
               for update`,
            );
            const previousCycleId = state.rows[0]?.published_cycle_id ?? null;
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
            if (previousCycleId === id && row.status === 'published') {
              await client.query('commit');
              return;
            }
            assertPublicationReady({
              completedRecipes: row.completed_recipes,
              failedRecipes: row.failed_recipes,
              status: row.status as RefreshCycle['status'],
              totalRecipes: row.total_recipes,
            });

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
          if (cycle.status === 'running') {
            const [running] = await database
              .select({ id: refreshCycles.id })
              .from(refreshCycles)
              .where(eq(refreshCycles.status, 'running'))
              .limit(1);
            assertSingleRunningCycle(running?.id ?? null, cycle.id);
          }
          const [current] = await database
            .select({ status: refreshCycles.status })
            .from(refreshCycles)
            .where(eq(refreshCycles.id, cycle.id))
            .limit(1);
          if (current) {
            assertRefreshTransition(
              current.status as RefreshCycle['status'],
              cycle.status,
            );
            assertRefreshCycleInvariant(cycle);
          } else {
            assertNewRefreshCycle(cycle);
          }
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
      claimNext(workerId, now, kinds) {
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
                 and ($3::text[] is null or kind = any($3::text[]))
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
            [workerId, now, kinds ? [...kinds] : null],
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
        assertNewJob(job);
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
          const client = await pool.connect();
          try {
            await client.query('begin');
            const result = await client.query<{
              kind: string;
              refresh_cycle_id: string | null;
              status: string;
            }>(
              `update jobs
               set status = case when attempts < max_attempts then 'retry' else 'failed' end,
                   run_after = $3,
                   locked_at = null,
                   locked_by = null,
                   last_error = $2,
                   updated_at = $4
               where id = $1 and status = 'running'
               returning status, kind, refresh_cycle_id`,
              [id, error, retryAt, now],
            );
            const failed = result.rows[0];
            if (!failed) {
              throw new RepositoryNotFoundError('jobs', 'fail');
            }
            if (
              failed.status === 'failed' &&
              failed.kind === 'recipe_refresh' &&
              failed.refresh_cycle_id
            ) {
              await incrementFailedQueries(
                client,
                failed.refresh_cycle_id,
                1,
                now,
              );
            }
            await client.query('commit');
          } catch (caught) {
            await client.query('rollback').catch(() => undefined);
            throw caught;
          } finally {
            client.release();
          }
        });
      },
      failPermanently(id, error, now) {
        return mapRepositoryError('jobs', 'failPermanently', async () => {
          const client = await pool.connect();
          try {
            await client.query('begin');
            const result = await client.query<{
              kind: string;
              refresh_cycle_id: string | null;
            }>(
              `update jobs
               set status = 'failed', locked_at = null, locked_by = null,
                   last_error = $2, updated_at = $3
               where id = $1 and status = 'running'
               returning kind, refresh_cycle_id`,
              [id, error, now],
            );
            const failed = result.rows[0];
            if (!failed) {
              throw new RepositoryNotFoundError('jobs', 'failPermanently');
            }
            if (failed.kind === 'recipe_refresh' && failed.refresh_cycle_id) {
              await incrementFailedQueries(
                client,
                failed.refresh_cycle_id,
                1,
                now,
              );
            }
            await client.query('commit');
          } catch (caught) {
            await client.query('rollback').catch(() => undefined);
            throw caught;
          } finally {
            client.release();
          }
        });
      },
      recoverStale(before, retryAt, now) {
        return mapRepositoryError('jobs', 'recoverStale', async () => {
          const client = await pool.connect();
          try {
            await client.query('begin');
            const result = await client.query<{
              kind: string;
              refresh_cycle_id: string | null;
              status: string;
            }>(
              `update jobs
               set status = case when attempts < max_attempts then 'retry' else 'failed' end,
                   run_after = $2, locked_at = null, locked_by = null,
                   last_error = 'worker_lease_expired', updated_at = $3
               where status = 'running' and locked_at <= $1
               returning status, kind, refresh_cycle_id`,
              [before, retryAt, now],
            );
            const failedByCycle = new Map<string, number>();
            for (const recovered of result.rows) {
              if (
                recovered.status === 'failed' &&
                recovered.kind === 'recipe_refresh' &&
                recovered.refresh_cycle_id
              ) {
                failedByCycle.set(
                  recovered.refresh_cycle_id,
                  (failedByCycle.get(recovered.refresh_cycle_id) ?? 0) + 1,
                );
              }
            }
            for (const [cycleId, count] of failedByCycle) {
              await incrementFailedQueries(client, cycleId, count, now);
            }
            await client.query('commit');
            return result.rows.length;
          } catch (caught) {
            await client.query('rollback').catch(() => undefined);
            throw caught;
          } finally {
            client.release();
          }
        });
      },
    },
    retention: {
      cleanup(options) {
        return mapRepositoryError('retention', 'cleanup', async () => {
          if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
            throw new TypeError('batchSize must be a positive integer');
          }
          const client = await pool.connect();
          try {
            await client.query('begin');
            await client.query(
              `insert into catalog_state (id)
               values (1)
               on conflict (id) do nothing`,
            );
            await client.query(
              `select id from catalog_state where id = 1 for update`,
            );
            const rawSnapshotsResult = await client.query(
              `delete from raw_snapshots
               where id in (
                 select snapshot.id
                 from raw_snapshots snapshot
                 where snapshot.captured_at < $1
                   and not exists (
                     select 1 from refresh_cycles cycle
                     where cycle.id = snapshot.refresh_cycle_id
                       and cycle.status in ('queued', 'running')
                   )
                   and not exists (
                     select 1 from catalog_state state
                     where state.id = 1
                       and state.published_cycle_id = snapshot.refresh_cycle_id
                   )
                 order by snapshot.id
                 limit $2
               )
               returning id`,
              [options.rawSnapshotsBefore, options.batchSize],
            );
            const observationsResult = await client.query(
              `delete from aggregated_observations
               where id in (
                 select observation.id
                 from aggregated_observations observation
                 where observation.observed_at < $1
                   and not exists (
                     select 1 from refresh_cycles cycle
                     where cycle.id = observation.refresh_cycle_id
                       and cycle.status in ('queued', 'running')
                   )
                   and not exists (
                     select 1 from catalog_state state
                     where state.id = 1
                       and state.published_cycle_id = observation.refresh_cycle_id
                   )
                 order by observation.id
                 limit $2
               )
               returning id`,
              [options.observationsBefore, options.batchSize],
            );
            const jobsResult = await client.query(
              `delete from jobs
               where id in (
                 select job.id
                 from jobs job
                 where job.status in ('succeeded', 'failed')
                   and job.updated_at < $1
                   and not exists (
                     select 1 from refresh_cycles cycle
                     where cycle.id = job.refresh_cycle_id
                       and cycle.status in ('queued', 'running')
                   )
                   and not exists (
                     select 1 from catalog_state state
                     where state.id = 1
                       and state.published_cycle_id = job.refresh_cycle_id
                   )
                 order by job.updated_at, job.id
                 limit $2
               )
               returning id`,
              [options.jobsBefore, options.batchSize],
            );
            await client.query('commit');
            return {
              jobs: jobsResult.rowCount ?? 0,
              observations: observationsResult.rowCount ?? 0,
              rawSnapshots: rawSnapshotsResult.rowCount ?? 0,
            };
          } catch (error) {
            await client.query('rollback').catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        });
      },
    },
  };
}

async function incrementFailedQueries(
  client: PoolClient,
  cycleId: string,
  count: number,
  now: Date,
) {
  const result = await client.query(
    `update refresh_cycles
     set failed_queries = failed_queries + $2, updated_at = $3
     where id = $1
       and completed_queries + failed_queries + $2 <= total_queries
     returning id`,
    [cycleId, count, now],
  );
  if (!result.rowCount) {
    throw new RepositoryNotFoundError('cycles', 'incrementFailedQueries');
  }
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
