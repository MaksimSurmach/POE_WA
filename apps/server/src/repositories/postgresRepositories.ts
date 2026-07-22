import type {
  AggregatedObservation,
  Job,
  LeagueUpsert,
  MarketQuery,
  ProviderCircuitState,
  RawSnapshot,
  RateLimitState,
  RateLimitWindow,
  Recipe,
  RecipeEvaluation,
  RefreshCycle,
  PoeLeague,
  Repositories,
  StoredCraftProbability,
} from '@poe-worksmith/domain';
import {
  DomainError,
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
  craftProbabilityResults,
  jobs,
  marketQueries,
  poeLeagues,
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
type LeagueRow = typeof poeLeagues.$inferSelect;
type CraftProbabilityRow = typeof craftProbabilityResults.$inferSelect;
type RateLimitStateSqlRow = {
  blocked_until: Date;
  endpoints: string[];
  last_response_at: Date | null;
  last_status: number | null;
  minimum_delay_ms: number;
  next_request_at: Date;
  policy: string;
  updated_at: Date;
  windows: RateLimitWindow[];
};
type ProviderCircuitSqlRow = {
  consecutive_failures: number;
  endpoint: string;
  last_failure_code: string | null;
  opened_at: Date | null;
  probe_lease_until: Date | null;
  provider: string;
  retry_at: Date | null;
  status: ProviderCircuitState['status'];
  updated_at: Date;
};

export function createPostgresRepositories(pool: Pool): Repositories {
  const database = drizzle({ client: pool });

  return {
    craftProbabilities: {
      findByCacheKey(cacheKey) {
        return mapRepositoryError(
          'craftProbabilities',
          'findByCacheKey',
          async () => {
            const [row] = await database
              .select()
              .from(craftProbabilityResults)
              .where(eq(craftProbabilityResults.cacheKey, cacheKey))
              .limit(1);
            return row ? mapCraftProbability(row) : null;
          },
        );
      },
      save(result) {
        return mapRepositoryError('craftProbabilities', 'save', async () => {
          const [inserted] = await database
            .insert(craftProbabilityResults)
            .values(craftProbabilityValues(result))
            .onConflictDoNothing()
            .returning();
          if (inserted) return mapCraftProbability(inserted);
          const [existing] = await database
            .select()
            .from(craftProbabilityResults)
            .where(eq(craftProbabilityResults.cacheKey, result.cacheKey))
            .limit(1);
          if (!existing)
            throw new Error('Probability result disappeared after conflict');
          const stored = mapCraftProbability(existing);
          if (JSON.stringify(stored) !== JSON.stringify(result)) {
            throw new DomainError('PERSISTENCE_CONFLICT');
          }
          return stored;
        });
      },
    },
    leagues: {
      list() {
        return mapRepositoryError('leagues', 'list', async () =>
          (
            await database
              .select()
              .from(poeLeagues)
              .orderBy(desc(poeLeagues.startAt), desc(poeLeagues.createdAt))
          ).map(mapLeague),
        );
      },
      findCurrent() {
        return mapRepositoryError('leagues', 'findCurrent', async () => {
          const [row] = await database
            .select()
            .from(poeLeagues)
            .where(eq(poeLeagues.isCurrent, true))
            .limit(1);
          return row ? mapLeague(row) : null;
        });
      },
      upsert(input: LeagueUpsert) {
        return mapRepositoryError('leagues', 'upsert', async () => {
          const [row] = await database
            .insert(poeLeagues)
            .values({ ...input, metadata: { ...input.metadata } })
            .onConflictDoUpdate({
              target: [poeLeagues.game, poeLeagues.realm, poeLeagues.gggId],
              set: {
                name: input.name,
                syncedAt: input.syncedAt,
                metadata: { ...input.metadata },
                updatedAt: new Date(),
              },
            })
            .returning();
          return mapLeague(row!);
        });
      },
      setCurrent(leagueId: string, switchedAt: Date) {
        return mapRepositoryError('leagues', 'setCurrent', async () => {
          const client = await pool.connect();
          try {
            await client.query('begin');
            const selected = await client.query<LeagueRow>(
              'select * from poe_leagues where id = $1 for update',
              [leagueId],
            );
            const row = selected.rows[0];
            if (!row)
              throw new RepositoryNotFoundError('leagues', 'setCurrent');
            if (row.isCurrent) {
              await client.query('commit');
              return mapLeague(row);
            }
            const current = await client.query<LeagueRow>(
              'select * from poe_leagues where game = $1 and realm = $2 and is_current = true for update',
              [row.game, row.realm],
            );
            if (current.rows[0] && !current.rows[0].endAt && row.startAt)
              await client.query(
                'update poe_leagues set is_current = false, end_at = $2, updated_at = $2 where id = $1',
                [current.rows[0].id, row.startAt],
              );
            else
              await client.query(
                'update poe_leagues set is_current = false, updated_at = $2 where game = $1 and realm = $3 and is_current = true',
                [row.game, switchedAt, row.realm],
              );
            const updated = await client.query<LeagueRow>(
              'update poe_leagues set is_current = true, updated_at = $2 where id = $1 returning *',
              [leagueId, switchedAt],
            );
            await client.query('commit');
            return mapLeague(updated.rows[0]!);
          } catch (error) {
            await client.query('rollback').catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        });
      },
    },
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
    operationalDiagnostics: {
      read(input) {
        return mapRepositoryError(
          'operationalDiagnostics',
          'read',
          async () => {
            if (
              !Number.isInteger(input.recentCycles) ||
              !Number.isInteger(input.recentFailures)
            )
              throw new TypeError('Diagnostic limits must be integers');
            const [cyclesResult, evaluationsResult, jobsResult] =
              await Promise.all([
                pool.query(
                  `select id as "cycleId", league_id as "leagueId", status, requested_at as "requestedAt", started_at as "startedAt", finished_at as "finishedAt", published_at as "publishedAt", error_message as "errorCode" from refresh_cycles order by requested_at desc limit $1`,
                  [input.recentCycles],
                ),
                pool.query(
                  `select refresh_cycle_id as "cycleId", league_id as "leagueId", recipe_id as "recipeId", status, error_code as "errorCode", evaluated_at as "evaluatedAt" from recipe_evaluations where status in ('stale', 'partial', 'error') order by evaluated_at desc limit $1`,
                  [input.recentFailures],
                ),
                pool.query(
                  `select id as "jobId", refresh_cycle_id as "cycleId", payload->>'provider' as provider, payload->>'canonicalHash' as "queryHash", status, attempts, last_error as "errorCode", updated_at as "updatedAt" from jobs where status in ('retry', 'failed') order by updated_at desc limit $1`,
                  [input.recentFailures],
                ),
              ]);
            return {
              cycles: cyclesResult.rows,
              evaluations: evaluationsResult.rows,
              jobs: jobsResult.rows,
            };
          },
        );
      },
    },
    providerCircuits: {
      acquire(input) {
        return mapRepositoryError('providerCircuits', 'acquire', async () => {
          assertProviderCircuitInput(input.provider, input.endpoint, input.now);
          if (!Number.isInteger(input.probeLeaseMs) || input.probeLeaseMs < 1) {
            throw new TypeError('Circuit probe lease must be positive');
          }
          const client = await pool.connect();
          try {
            await client.query('begin');
            await lockProviderCircuit(client, input.provider, input.endpoint);
            await insertProviderCircuit(
              client,
              input.provider,
              input.endpoint,
              input.now,
            );
            let state = await selectProviderCircuitForUpdate(
              client,
              input.provider,
              input.endpoint,
            );
            let allowed = state.status === 'closed';
            let retryAt = state.retry_at;
            const cooldownElapsed =
              state.status === 'open' &&
              state.retry_at !== null &&
              state.retry_at <= input.now;
            const probeExpired =
              state.status === 'half_open' &&
              (!state.probe_lease_until ||
                state.probe_lease_until <= input.now);
            if (cooldownElapsed || probeExpired) {
              const probeLeaseUntil = new Date(
                input.now.getTime() + input.probeLeaseMs,
              );
              const result = await client.query<ProviderCircuitSqlRow>(
                `update provider_circuits
                   set status = 'half_open', retry_at = null,
                       probe_lease_until = $4, updated_at = $3
                   where provider = $1 and endpoint = $2
                   returning *`,
                [input.provider, input.endpoint, input.now, probeLeaseUntil],
              );
              state = result.rows[0]!;
              allowed = true;
              retryAt = null;
            } else if (state.status === 'open') {
              allowed = false;
            } else if (state.status === 'half_open') {
              allowed = false;
              retryAt = state.probe_lease_until;
            }
            await client.query('commit');
            return {
              allowed,
              retryAt,
              state: mapProviderCircuit(state),
            };
          } catch (error) {
            await client.query('rollback').catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        });
      },
      list() {
        return mapRepositoryError('providerCircuits', 'list', async () => {
          const result = await pool.query<ProviderCircuitSqlRow>(
            `select * from provider_circuits order by provider, endpoint`,
          );
          return result.rows.map(mapProviderCircuit);
        });
      },
      recordFailure(input) {
        return mapRepositoryError(
          'providerCircuits',
          'recordFailure',
          async () => {
            assertProviderCircuitInput(
              input.provider,
              input.endpoint,
              input.now,
            );
            if (
              input.errorCode.trim().length === 0 ||
              !Number.isInteger(input.failureThreshold) ||
              input.failureThreshold < 1 ||
              !Number.isInteger(input.cooldownMs) ||
              input.cooldownMs < 1
            ) {
              throw new TypeError('Circuit failure input is invalid');
            }
            const client = await pool.connect();
            try {
              await client.query('begin');
              await lockProviderCircuit(client, input.provider, input.endpoint);
              await insertProviderCircuit(
                client,
                input.provider,
                input.endpoint,
                input.now,
              );
              const current = await selectProviderCircuitForUpdate(
                client,
                input.provider,
                input.endpoint,
              );
              const consecutiveFailures = current.consecutive_failures + 1;
              const shouldOpen =
                current.status !== 'closed' ||
                consecutiveFailures >= input.failureThreshold;
              const requestedRetryAt = new Date(
                input.now.getTime() + input.cooldownMs,
              );
              const retryAt = shouldOpen
                ? new Date(
                    Math.max(
                      requestedRetryAt.getTime(),
                      current.retry_at?.getTime() ?? 0,
                    ),
                  )
                : null;
              const result = await client.query<ProviderCircuitSqlRow>(
                `update provider_circuits
                 set status = $4, consecutive_failures = $5,
                     opened_at = $6, retry_at = $7,
                     probe_lease_until = null, last_failure_code = $8,
                     updated_at = $3
                 where provider = $1 and endpoint = $2
                 returning *`,
                [
                  input.provider,
                  input.endpoint,
                  input.now,
                  shouldOpen ? 'open' : 'closed',
                  consecutiveFailures,
                  shouldOpen ? input.now : null,
                  retryAt,
                  input.errorCode,
                ],
              );
              await client.query('commit');
              return mapProviderCircuit(result.rows[0]!);
            } catch (error) {
              await client.query('rollback').catch(() => undefined);
              throw error;
            } finally {
              client.release();
            }
          },
        );
      },
      recordSuccess(input) {
        return mapRepositoryError(
          'providerCircuits',
          'recordSuccess',
          async () => {
            assertProviderCircuitInput(
              input.provider,
              input.endpoint,
              input.now,
            );
            const client = await pool.connect();
            try {
              await client.query('begin');
              await lockProviderCircuit(client, input.provider, input.endpoint);
              const result = await client.query<ProviderCircuitSqlRow>(
                `insert into provider_circuits
                   (provider, endpoint, status, consecutive_failures,
                    opened_at, retry_at, probe_lease_until,
                    last_failure_code, updated_at)
                 values ($1, $2, 'closed', 0, null, null, null, null, $3)
                 on conflict (provider, endpoint) do update
                 set status = 'closed', consecutive_failures = 0,
                     opened_at = null, retry_at = null,
                     probe_lease_until = null, last_failure_code = null,
                     updated_at = excluded.updated_at
                 returning *`,
                [input.provider, input.endpoint, input.now],
              );
              await client.query('commit');
              return mapProviderCircuit(result.rows[0]!);
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
    rateLimits: {
      acquire(input) {
        return mapRepositoryError('rateLimits', 'acquire', async () => {
          assertRateLimitInput(
            input.endpoint,
            input.fallbackPolicy,
            input.now,
            input.conservativeDelayMs,
          );
          const client = await pool.connect();
          try {
            await client.query('begin');
            await lockRateLimitEndpoint(client, input.endpoint);
            const mapping = await client.query<{ policy: string }>(
              `select policy
               from rate_limit_endpoint_policies
               where endpoint = $1
               for update`,
              [input.endpoint],
            );
            const policy =
              mapping.rows[0]?.policy ?? input.fallbackPolicy.trim();
            await insertRateLimitState(
              client,
              policy,
              input.now,
              input.conservativeDelayMs,
            );
            const locked = await selectRateLimitStateForUpdate(client, policy);
            const retryAt = new Date(
              Math.max(
                locked.blocked_until.getTime(),
                locked.next_request_at.getTime(),
                input.now.getTime(),
              ),
            );
            const acquired = retryAt <= input.now;
            if (acquired) {
              await client.query(
                `update rate_limit_states
                 set next_request_at = $2, updated_at = $1
                 where policy = $3`,
                [
                  input.now,
                  new Date(input.now.getTime() + locked.minimum_delay_ms),
                  policy,
                ],
              );
            }
            await client.query(
              `insert into rate_limit_endpoint_policies
                 (endpoint, policy, updated_at)
               values ($1, $2, $3)
               on conflict (endpoint) do nothing`,
              [input.endpoint, policy, input.now],
            );
            const state = await selectRateLimitState(client, policy);
            await client.query('commit');
            return { acquired, retryAt, state };
          } catch (error) {
            await client.query('rollback').catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        });
      },
      list() {
        return mapRepositoryError('rateLimits', 'list', async () => {
          const result = await pool.query<RateLimitStateSqlRow>(
            rateLimitStateSelectSql(),
          );
          return result.rows.map(mapRateLimitState);
        });
      },
      observe(input) {
        return mapRepositoryError('rateLimits', 'observe', async () => {
          assertRateLimitInput(
            input.endpoint,
            input.fallbackPolicy,
            input.now,
            input.minimumDelayMs,
          );
          assertRateLimitObservation(input.status, input.windows);
          assertRateLimitInput(
            input.endpoint,
            input.policy,
            input.blockedUntil,
            input.minimumDelayMs,
          );
          const client = await pool.connect();
          try {
            await client.query('begin');
            await lockRateLimitEndpoint(client, input.endpoint);
            const mapping = await client.query<{ policy: string }>(
              `select policy
               from rate_limit_endpoint_policies
               where endpoint = $1
               for update`,
              [input.endpoint],
            );
            const previousPolicy =
              mapping.rows[0]?.policy ?? input.fallbackPolicy.trim();
            const policy = input.policy.trim();
            const policies = [...new Set([previousPolicy, policy])].sort();
            for (const candidate of policies) {
              await insertRateLimitState(
                client,
                candidate,
                input.now,
                input.minimumDelayMs,
              );
            }
            const locked = await client.query<RateLimitStateSqlRow>(
              `select state.*, array[]::text[] as endpoints
               from rate_limit_states state
               where state.policy = any($1::text[])
               order by state.policy
               for update`,
              [policies],
            );
            const blockedUntil = new Date(
              Math.max(
                input.blockedUntil.getTime(),
                ...locked.rows.map(({ blocked_until: value }) =>
                  value.getTime(),
                ),
              ),
            );
            const nextRequestAt = new Date(
              Math.max(
                input.now.getTime() + input.minimumDelayMs,
                ...locked.rows.map(({ next_request_at: value }) =>
                  value.getTime(),
                ),
              ),
            );
            await client.query(
              `update rate_limit_states
               set blocked_until = $2, next_request_at = $3,
                   minimum_delay_ms = $4, windows = $5,
                   last_status = $6, last_response_at = $1,
                   updated_at = $1
               where policy = $7`,
              [
                input.now,
                blockedUntil,
                nextRequestAt,
                input.minimumDelayMs,
                JSON.stringify(input.windows),
                input.status,
                policy,
              ],
            );
            await client.query(
              `insert into rate_limit_endpoint_policies
                 (endpoint, policy, updated_at)
               values ($1, $2, $3)
               on conflict (endpoint) do update
               set policy = excluded.policy, updated_at = excluded.updated_at`,
              [input.endpoint, policy, input.now],
            );
            const state = await selectRateLimitState(client, policy);
            await client.query('commit');
            return state;
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
                league_id: string;
                total_queries: number;
              }>(
                `select total_queries, completed_queries, failed_queries, league_id
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
                cycle.league_id !== result.snapshot.leagueId ||
                cycle.league_id !== result.observation.leagueId
              ) {
                throw new Error(
                  'Market result does not match its cycle league',
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
                   (dedupe_key, market_query_id, refresh_cycle_id, league_id, captured_at,
                    expires_at, provider_status, payload)
                 values ($1, $2, $3, $4, $5, $6, $7, $8)
                 on conflict (dedupe_key) do nothing`,
                [
                  result.snapshot.dedupeKey,
                  result.snapshot.marketQueryId,
                  result.snapshot.refreshCycleId,
                  result.snapshot.leagueId,
                  result.snapshot.capturedAt,
                  result.snapshot.expiresAt,
                  result.snapshot.providerStatus,
                  JSON.stringify(result.snapshot.payload),
                ],
              );
              await client.query(
                `insert into aggregated_observations
                   (market_query_id, refresh_cycle_id, league_id, observed_at, sample_size,
                    currency, cheapest_price, nth_price, median_top_n_price, summary)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 on conflict (market_query_id, refresh_cycle_id) do nothing`,
                [
                  result.observation.marketQueryId,
                  result.observation.refreshCycleId,
                  result.observation.leagueId,
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
      findLatest(marketQueryId, leagueId) {
        return mapRepositoryError('snapshots', 'findLatest', async () => {
          const [row] = await database
            .select()
            .from(rawSnapshots)
            .where(
              and(
                eq(rawSnapshots.marketQueryId, marketQueryId),
                eq(rawSnapshots.leagueId, leagueId),
              ),
            )
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
      listRecent(marketQueryId, leagueId, since) {
        return mapRepositoryError('observations', 'listRecent', async () => {
          const rows = await database
            .select()
            .from(aggregatedObservations)
            .where(
              and(
                eq(aggregatedObservations.marketQueryId, marketQueryId),
                eq(aggregatedObservations.leagueId, leagueId),
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
      findLatestAttempt() {
        return mapRepositoryError('cycles', 'findLatestAttempt', async () => {
          const [cycle] = await database
            .select()
            .from(refreshCycles)
            .orderBy(desc(refreshCycles.requestedAt))
            .limit(1);
          return cycle ? mapCycle(cycle) : null;
        });
      },
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
              league_id: string;
              status: string;
              total_recipes: number;
            }>(
              `select status, league_id, total_recipes, completed_recipes, failed_recipes
               from refresh_cycles
               where id = $1
               for update`,
              [id],
            );
            const row = candidate.rows[0];
            if (!row) throw new RepositoryNotFoundError('cycles', 'publish');
            if (previousCycleId === id && row.status === 'published') {
              await client.query('commit');
              return true;
            }
            assertPublicationReady({
              completedRecipes: row.completed_recipes,
              failedRecipes: row.failed_recipes,
              status: row.status as RefreshCycle['status'],
              totalRecipes: row.total_recipes,
            });
            const currentLeague = await client.query<{ id: string }>(
              `select id from poe_leagues where is_current = true for share`,
            );
            if (currentLeague.rows[0]?.id !== row.league_id) {
              await client.query(
                `update refresh_cycles
                 set status = 'completed', finished_at = $2,
                     error_message = 'CATALOG_PUBLICATION_SKIPPED_LEAGUE_CHANGED', updated_at = $2
                 where id = $1`,
                [id, publishedAt],
              );
              await client.query('commit');
              return false;
            }

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
            return true;
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

async function lockProviderCircuit(
  client: PoolClient,
  provider: string,
  endpoint: string,
) {
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `provider-circuit:${provider}:${endpoint}`,
  ]);
}

async function insertProviderCircuit(
  client: PoolClient,
  provider: string,
  endpoint: string,
  now: Date,
) {
  await client.query(
    `insert into provider_circuits
       (provider, endpoint, updated_at)
     values ($1, $2, $3)
     on conflict (provider, endpoint) do nothing`,
    [provider, endpoint, now],
  );
}

async function selectProviderCircuitForUpdate(
  client: PoolClient,
  provider: string,
  endpoint: string,
) {
  const result = await client.query<ProviderCircuitSqlRow>(
    `select * from provider_circuits
     where provider = $1 and endpoint = $2
     for update`,
    [provider, endpoint],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RepositoryNotFoundError('providerCircuits', 'selectForUpdate');
  }
  return row;
}

function mapProviderCircuit(row: ProviderCircuitSqlRow): ProviderCircuitState {
  return {
    consecutiveFailures: row.consecutive_failures,
    endpoint: row.endpoint,
    lastFailureCode: row.last_failure_code,
    openedAt: row.opened_at,
    probeLeaseUntil: row.probe_lease_until,
    provider: row.provider,
    retryAt: row.retry_at,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function assertProviderCircuitInput(
  provider: string,
  endpoint: string,
  now: Date,
) {
  if (
    provider.trim().length === 0 ||
    provider.length > 200 ||
    endpoint.trim().length === 0 ||
    endpoint.length > 200 ||
    !Number.isFinite(now.getTime())
  ) {
    throw new TypeError('Provider circuit input is invalid');
  }
}

async function insertRateLimitState(
  client: PoolClient,
  policy: string,
  now: Date,
  minimumDelayMs: number,
) {
  await client.query(
    `insert into rate_limit_states
       (policy, blocked_until, next_request_at, minimum_delay_ms,
        updated_at)
     values ($1, $2, $2, $3, $2)
     on conflict (policy) do nothing`,
    [policy, now, minimumDelayMs],
  );
}

async function lockRateLimitEndpoint(client: PoolClient, endpoint: string) {
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `rate-limit:${endpoint}`,
  ]);
}

async function selectRateLimitStateForUpdate(
  client: PoolClient,
  policy: string,
) {
  const result = await client.query<RateLimitStateSqlRow>(
    `select state.*, array[]::text[] as endpoints
     from rate_limit_states state
     where state.policy = $1
     for update`,
    [policy],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RepositoryNotFoundError('rateLimits', 'selectForUpdate');
  }
  return row;
}

async function selectRateLimitState(client: PoolClient, policy: string) {
  const result = await client.query<RateLimitStateSqlRow>(
    rateLimitStateSelectSql('where state.policy = $1'),
    [policy],
  );
  const row = result.rows[0];
  if (!row) throw new RepositoryNotFoundError('rateLimits', 'select');
  return mapRateLimitState(row);
}

function rateLimitStateSelectSql(filter = '') {
  return `select state.policy, state.blocked_until, state.next_request_at,
                 state.minimum_delay_ms, state.windows, state.last_status,
                 state.last_response_at, state.updated_at,
                 coalesce(
                   array_agg(mapping.endpoint order by mapping.endpoint)
                     filter (where mapping.endpoint is not null),
                   array[]::text[]
                 ) as endpoints
          from rate_limit_states state
          left join rate_limit_endpoint_policies mapping
            on mapping.policy = state.policy
          ${filter}
          group by state.policy
          having count(mapping.endpoint) > 0
          order by state.policy`;
}

function mapRateLimitState(row: RateLimitStateSqlRow): RateLimitState {
  return {
    blockedUntil: row.blocked_until,
    endpoints: [...row.endpoints],
    lastResponseAt: row.last_response_at,
    lastStatus: row.last_status,
    minimumDelayMs: row.minimum_delay_ms,
    nextRequestAt: row.next_request_at,
    policy: row.policy,
    updatedAt: row.updated_at,
    windows: row.windows.map((window) => ({ ...window })),
  };
}

function assertRateLimitInput(
  endpoint: string,
  policy: string,
  at: Date,
  minimumDelayMs: number,
) {
  if (
    endpoint.trim().length === 0 ||
    endpoint.length > 200 ||
    policy.trim().length === 0 ||
    policy.length > 200 ||
    !Number.isFinite(at.getTime()) ||
    !Number.isInteger(minimumDelayMs) ||
    minimumDelayMs < 1
  ) {
    throw new TypeError('Rate-limit input is invalid');
  }
}

function assertRateLimitObservation(
  status: number,
  windows: readonly RateLimitWindow[],
) {
  if (
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599 ||
    windows.some(
      (window) =>
        window.rule.length === 0 ||
        !Number.isInteger(window.maximumHits) ||
        window.maximumHits < 1 ||
        !Number.isInteger(window.periodSeconds) ||
        window.periodSeconds < 1 ||
        !Number.isInteger(window.restrictionSeconds) ||
        window.restrictionSeconds < 0 ||
        !Number.isInteger(window.currentHits) ||
        window.currentHits < 0 ||
        !Number.isInteger(window.activeRestrictionSeconds) ||
        window.activeRestrictionSeconds < 0,
    )
  ) {
    throw new TypeError('Rate-limit observation is invalid');
  }
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
  return {
    active: row.active,
    category: row.category,
    contentHash: row.contentHash,
    craftMethod: row.craftMethod,
    definition: row.definition,
    gameVersion: row.gameVersion,
    guideMarkdown: row.guideMarkdown,
    id: row.id,
    tags: row.tags,
    title: row.title,
  };
}

function mapMarketQuery(row: MarketQueryRow): MarketQuery {
  return {
    active: row.active,
    canonicalHash: row.canonicalHash,
    id: row.id,
    provider: row.provider,
    query: row.query,
    recipeId: row.recipeId,
  };
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

function mapLeague(row: LeagueRow): PoeLeague {
  return { ...row, metadata: row.metadata };
}

function craftProbabilityValues(result: StoredCraftProbability) {
  return {
    cacheKey: result.cacheKey,
    setupHash: result.setupHash,
    gameDataVersion: result.gameDataVersion,
    rulesetId: result.rulesetId,
    engineId: result.engineId,
    engineVersion: result.engineVersion,
    calculatorContractVersion: result.calculatorContractVersion,
    probabilityNumerator: result.probability.numerator,
    probabilityDenominator: result.probability.denominator,
    expectedAttemptsNumerator: result.expectedAttempts.numerator,
    expectedAttemptsDenominator: result.expectedAttempts.denominator,
    probabilityDecimal: result.probabilityDecimal,
    expectedAttemptsDecimal: result.expectedAttemptsDecimal,
    diagnostics: [...result.diagnostics],
    calculatedAt: result.calculatedAt,
    createdAt: result.createdAt,
  };
}

function mapCraftProbability(row: CraftProbabilityRow): StoredCraftProbability {
  return {
    cacheKey: row.cacheKey,
    setupHash: row.setupHash,
    gameDataVersion: row.gameDataVersion,
    rulesetId: row.rulesetId,
    engineId: row.engineId,
    engineVersion: row.engineVersion,
    calculatorContractVersion: row.calculatorContractVersion,
    calculatorVersion: String(row.calculatorContractVersion),
    probability: {
      numerator: row.probabilityNumerator,
      denominator: row.probabilityDenominator,
    },
    probabilityDecimal: row.probabilityDecimal,
    expectedAttempts: {
      numerator: row.expectedAttemptsNumerator,
      denominator: row.expectedAttemptsDenominator,
    },
    expectedAttemptsDecimal: row.expectedAttemptsDecimal,
    diagnostics: row.diagnostics as StoredCraftProbability['diagnostics'],
    calculatedAt: row.calculatedAt,
    createdAt: row.createdAt,
  };
}
