import type {
  ProviderCircuitState,
  RateLimitState,
  RateLimitWindow,
  Repositories,
} from '@poe-worksmith/domain';
import type { Pool, PoolClient } from 'pg';

import { tradeCapturePolicyPredicate } from './collectorQueue.js';
import { mapRepositoryError, RepositoryNotFoundError } from './errors.js';

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

export async function clearTradeAuthenticationDenials(
  pool: Pick<Pool, 'query'>,
  now: Date,
) {
  await pool.query(
    `update rate_limit_states state
     set last_status = null, updated_at = $1
     where last_status = 401
       and (
         policy = any($2::text[])
         or policy in (
           select policy from rate_limit_endpoint_policies
           where endpoint = any($3::text[])
         )
       )`,
    [
      now,
      [
        'poe-trade',
        'trade-search-request-limit',
        'trade-fetch-request-limit',
        'trade-exchange-request-limit',
      ],
      ['trade', 'trade-search', 'trade-fetch', 'trade-exchange'],
    ],
  );
}

export function createPostgresProviderRepositories(
  pool: Pool,
): Pick<Repositories, 'providerCircuits' | 'rateLimits'> {
  return {
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
              `select distinct policy from rate_limit_endpoint_policies
               where endpoint = $1
                  or ($1 = 'trade' and endpoint in ('trade-search', 'trade-fetch'))`,
              [input.endpoint],
            );
            const policies = [
              ...new Set(mapping.rows.map(({ policy }) => policy)),
            ];
            if (policies.length === 0) {
              policies.push(input.fallbackPolicy.trim());
              await insertRateLimitState(
                client,
                policies[0]!,
                input.now,
                input.conservativeDelayMs,
              );
              await client.query(
                `insert into rate_limit_endpoint_policies (endpoint, policy, updated_at)
                 values ($1, $2, $3) on conflict (endpoint) do nothing`,
                [input.endpoint, policies[0], input.now],
              );
            }
            const locked = await client.query<RateLimitStateSqlRow>(
              `select state.*, array[]::text[] as endpoints from rate_limit_states state
               where policy = any($1::text[]) order by policy for update`,
              [policies],
            );
            const sharedBlock = input.tradeCapture
              ? (
                  await client.query<{ until: Date | null }>(
                    `select max(blocked_until) as until from rate_limit_states r
                   where ${tradeCapturePolicyPredicate}`,
                  )
                ).rows[0]?.until
              : null;
            const blockedUntil = new Date(
              Math.max(
                sharedBlock?.getTime() ?? 0,
                ...locked.rows.map((state) => state.blocked_until.getTime()),
              ),
            );
            const retryAt = new Date(
              Math.max(
                input.now.getTime(),
                blockedUntil.getTime(),
                ...locked.rows.map((state) => state.next_request_at.getTime()),
              ),
            );
            const acquired = retryAt <= input.now;
            if (acquired) {
              await client.query(
                `update rate_limit_states
                 set next_request_at = $1::timestamptz + minimum_delay_ms * interval '1 millisecond', updated_at = $1
                 where policy = any($2::text[])`,
                [input.now, policies],
              );
            }
            // Report a denial from any applicable policy, even if another response arrived later.
            const governing =
              locked.rows.find(
                ({ last_status }) => last_status === 401 || last_status === 403,
              ) ?? locked.rows[0];
            if (!governing)
              throw new RepositoryNotFoundError('rateLimits', 'acquire');
            const state = await selectRateLimitState(client, governing.policy);
            await client.query('commit');
            return { acquired, blockedUntil, retryAt, state };
          } catch (error) {
            await client.query('rollback').catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        });
      },
      clearAuthenticationDenials(now) {
        return mapRepositoryError(
          'rateLimits',
          'clearAuthenticationDenials',
          async () => {
            await clearTradeAuthenticationDenials(pool, now);
          },
        );
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
            const policy =
              input.windows.length === 0 &&
              input.policy === input.fallbackPolicy
                ? previousPolicy
                : input.policy.trim();
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
            const current = locked.rows.find((row) => row.policy === policy);
            const minimumDelayMs =
              input.windows.length === 0
                ? Math.max(
                    input.minimumDelayMs,
                    ...locked.rows.map(
                      ({ minimum_delay_ms }) => minimum_delay_ms,
                    ),
                  )
                : input.minimumDelayMs;
            const nextRequestAt = new Date(
              Math.max(
                input.now.getTime() + minimumDelayMs,
                ...locked.rows.map(({ next_request_at: value }) =>
                  value.getTime(),
                ),
              ),
            );
            await client.query(
              `update rate_limit_states
               set blocked_until = $2, next_request_at = $3,
                   minimum_delay_ms = $4, windows = $5,
                   last_status = case when last_status in (401, 403) then last_status else $6 end,
                   last_response_at = $1,
                   updated_at = $1
               where policy = $7`,
              [
                input.now,
                blockedUntil,
                nextRequestAt,
                minimumDelayMs,
                JSON.stringify(
                  input.windows.length === 0
                    ? (current?.windows ?? [])
                    : input.windows,
                ),
                locked.rows.find(
                  ({ last_status }) =>
                    last_status === 401 || last_status === 403,
                )?.last_status ??
                  (input.suppressAuthenticationDenial
                    ? (current?.last_status ?? null)
                    : input.status),
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
    `rate-limit:${['trade', 'trade-search', 'trade-fetch'].includes(endpoint) ? 'trade' : endpoint}`,
  ]);
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
          having count(mapping.endpoint) > 0 or state.last_status in (401, 403)
             or (state.policy = 'poe-trade' and state.blocked_until > state.last_response_at)
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
