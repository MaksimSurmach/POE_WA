import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  runCollector,
  type CollectorHandler,
  type CollectorResult,
} from './collector.js';
import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import {
  CollectorTelemetry,
  readCollectorDiagnostics,
} from './observability/collectorTelemetry.js';
import { GggRateLimitController } from './rateLimitController.js';
import type { PoolClient } from 'pg';
import { createPostgresRepositories } from './repositories/index.js';
import { readCollectorQueue } from './repositories/collectorQueue.js';
import { enqueueRunRequest } from './repositories/runRequestRepository.js';
import {
  captures,
  collectorSchedule,
  collectorState,
  runRequests,
} from './schema.js';

const config = loadDatabaseConfig();
const address = new URL(config.connectionString);
if (
  config.environment !== 'test' ||
  address.pathname !== '/poe_worksmith_test' ||
  address.port === '54326' ||
  !['localhost', '127.0.0.1', '[::1]', 'postgres-test'].includes(
    address.hostname,
  )
) {
  throw new Error(
    'Collector integration requires isolated local poe_worksmith_test',
  );
}

const pool = createDatabasePool({ ...config, maxConnections: 6 });
const db = drizzle({ client: pool });
const workers: { stop: AbortController; done: Promise<void> }[] = [];
const minute = 60_000;
const initial = new Date('2026-11-09T12:00:00Z').getTime();
let time = initial;
const now = () => new Date(time);

beforeEach(async () => {
  time = initial;
  await pool.query('truncate rate_limit_endpoint_policies, rate_limit_states');
});

afterEach(async () => {
  for (const worker of workers) worker.stop.abort();
  await Promise.all(workers.splice(0).map(({ done }) => done));
  await pool.query(
    'truncate listing_events, listings, captures, collector_schedule, run_requests, collector_state, collector_telemetry_runs',
  );
});

afterAll(() => pool.end());

async function schedule(
  overrides: Partial<typeof collectorSchedule.$inferInsert> = {},
) {
  const id = randomUUID();
  await db.insert(collectorSchedule).values({
    id,
    kind: 'trade-target',
    key: id,
    payload: {},
    intervalMinutes: 60,
    nextDueAt: now(),
    ...overrides,
  });
  return id;
}

async function row(id: string) {
  const [result] = await db
    .select()
    .from(collectorSchedule)
    .where(eq(collectorSchedule.id, id));
  return result!;
}

async function request(id: string) {
  const [result] = await db
    .select()
    .from(runRequests)
    .where(eq(runRequests.id, id));
  return result!;
}

function start(
  handle: CollectorHandler,
  maxIdleMs?: number,
  bootstrap?: (client: PoolClient, signal: AbortSignal) => Promise<void>,
  publishResults?: Parameters<typeof runCollector>[0]['publishResults'],
) {
  const stop = new AbortController();
  const done = runCollector({
    pool,
    signal: stop.signal,
    handlers: {
      'trade-target': handle,
      economy: handle,
      league: handle,
      retention: handle,
    },
    now,
    jitterMs: () => 0,
    maxIdleMs,
    ...(bootstrap ? { bootstrap } : {}),
    ...(publishResults ? { publishResults } : {}),
  });
  const worker = { stop, done };
  workers.push(worker);
  return worker;
}

const succeed = async (): Promise<CollectorResult> => ({
  status: 'success',
  capture: {
    capturedAt: now(),
    reportedTotal: 0,
    fetched: 0,
    complete: true,
    slices: 1,
    durationMs: 0,
    listings: [],
  },
});

async function leaderPid() {
  const { rows } = await pool.query<{ pid: number }>(
    `select pid from pg_locks
     where locktype = 'advisory' and objsubid = 1 and granted
       and ((classid::bigint << 32) | objid::bigint) = hashtext('poe-worksmith:collector')::bigint`,
  );
  return rows[0]?.pid;
}

async function wake() {
  await pool.query("select pg_notify('worksmith_wake', '')");
}

it('runs due rows once and advances their cadence', async () => {
  const due = await schedule();
  const future = await schedule({ nextDueAt: new Date(time + minute) });
  const handler = vi.fn(succeed);
  start(handler);
  await vi.waitFor(async () =>
    expect((await row(due)).lastStatus).toBe('succeeded'),
  );
  expect((await row(due)).nextDueAt.getTime()).toBe(initial + 60 * minute);
  expect((await row(future)).lastStartedAt).toBeNull();
  expect(handler).toHaveBeenCalledTimes(1);
  expect(await db.select().from(captures)).toHaveLength(1);
});

it('backs off failures and recovers a due row with an expired lease', async () => {
  const id = await schedule({
    attempt: 2,
    leasedUntil: new Date(time - 1),
  });
  const handler = vi
    .fn<CollectorHandler>()
    .mockRejectedValueOnce(new Error('provider failure'))
    .mockImplementation(succeed);
  start(handler);
  await vi.waitFor(async () =>
    expect((await row(id)).lastStatus).toBe('failed'),
  );
  expect(await row(id)).toMatchObject({
    attempt: 0,
    leasedUntil: null,
    retryAt: new Date(initial + 60 * minute),
  });
  time += 60 * minute;
  await wake();
  await vi.waitFor(async () =>
    expect((await row(id)).lastStatus).toBe('succeeded'),
  );
  expect(await row(id)).toMatchObject({ attempt: 0, retryAt: null });
  expect(handler).toHaveBeenCalledTimes(2);
});

it('wakes within one second for NOTIFY and processes a manual run', async () => {
  const id = await schedule({ nextDueAt: new Date(time + 60 * minute) });
  start(succeed);
  await vi.waitFor(async () => expect(await leaderPid()).toBeDefined());
  await delay(50);
  const requestedAt = performance.now();
  const requestId = await enqueueRunRequest(pool, null);
  await vi.waitFor(
    async () => expect((await request(requestId)).state).toBe('done'),
    { timeout: 1000 },
  );
  expect(performance.now() - requestedAt).toBeLessThan(1000);
  expect((await row(id)).lastStatus).toBe('succeeded');
});

it.each([false, true])(
  'does not finish Run now before pinned result writes (reject=%s)',
  async (reject) => {
    const scheduleId = await schedule({ nextDueAt: new Date(time + minute) });
    const requestId = await enqueueRunRequest(pool, null);
    const evidence: unknown[] = [];
    const publish = vi.fn<
      NonNullable<Parameters<typeof runCollector>[0]['publishResults']>
    >(async (_schedule, _at, client) => {
      const transaction = drizzle({ client });
      evidence.push({
        pinned: (await transaction.select().from(captures)).length,
        external: (await db.select().from(captures)).length,
        state: (await request(requestId)).state,
      });
      if (reject) throw new Error('recipe result write rejected');
    });
    start(succeed, undefined, undefined, publish);
    await vi.waitFor(async () => {
      expect((await request(requestId)).state).toBe(reject ? 'failed' : 'done');
    });
    expect(publish).toHaveBeenCalledOnce();
    expect(evidence).toEqual([{ pinned: 1, external: 0, state: 'running' }]);
    expect((await row(scheduleId)).lastStatus).toBe(
      reject ? 'failed' : 'succeeded',
    );
    expect(await db.select().from(captures)).toHaveLength(reject ? 0 : 1);
  },
);

it('publishes updated economy evidence without turning a partial collection into success', async () => {
  const id = await schedule({
    kind: 'economy',
    nextDueAt: new Date(time + minute),
  });
  const requestId = await enqueueRunRequest(pool, null);
  const publish = vi.fn(async () => {});
  start(
    async () => ({
      status: 'retry',
      reason: 'ECONOMY_UNAVAILABLE',
      economyUpdated: true,
    }),
    undefined,
    undefined,
    publish,
  );
  await vi.waitFor(async () =>
    expect((await request(requestId)).state).toBe('failed'),
  );
  expect(publish).toHaveBeenCalledOnce();
  expect(await row(id)).toMatchObject({
    attempt: 1,
    lastError: 'ECONOMY_UNAVAILABLE',
  });
});

it('processes a request queued while offline and one with a lost notification', async () => {
  const id = await schedule({ nextDueAt: new Date(time + 60 * minute) });
  const offline = await enqueueRunRequest(pool, null);
  const worker = start(succeed);
  await vi.waitFor(async () =>
    expect((await request(offline)).state).toBe('done'),
  );
  worker.stop.abort();
  await worker.done;

  start(succeed, 100);
  await vi.waitFor(async () => expect(await leaderPid()).toBeDefined());
  await delay(25);
  time += minute;
  const [lost] = await db
    .insert(runRequests)
    .values({ scope: 'all' })
    .returning({ id: runRequests.id });
  await vi.waitFor(async () =>
    expect((await request(lost!.id)).state).toBe('done'),
  );
  expect(
    await db.select().from(captures).where(eq(captures.scheduleId, id)),
  ).toHaveLength(2);
});

it('runs each due row once across two collectors and transfers leadership on disconnect', async () => {
  const first = await schedule();
  const leader = vi.fn(succeed);
  const standby = vi.fn(succeed);
  const worker = start(leader);
  await vi.waitFor(async () =>
    expect((await row(first)).lastStatus).toBe('succeeded'),
  );
  const originalPid = await leaderPid();
  start(standby);
  await vi.waitFor(async () => {
    const { rows } = await pool.query(
      `select pid from pg_locks where locktype = 'advisory' and objsubid = 1 and not granted
         and ((classid::bigint << 32) | objid::bigint) = hashtext('poe-worksmith:collector')::bigint`,
    );
    expect(rows).toHaveLength(1);
  });

  const second = await schedule();
  await pool.query('select pg_terminate_backend($1)', [originalPid]);
  worker.stop.abort();
  await vi.waitFor(async () =>
    expect((await row(second)).lastStatus).toBe('succeeded'),
  );
  expect(await leaderPid()).not.toBe(originalPid);
  expect(leader).toHaveBeenCalledTimes(1);
  expect(standby).toHaveBeenCalledTimes(1);
  expect(await db.select().from(captures)).toHaveLength(2);
});

it('fences an interrupted capture and resumes the durable request after its lease expires', async () => {
  const id = await schedule({ nextDueAt: new Date(time + 60 * minute) });
  const requestId = await enqueueRunRequest(pool, null);
  let release!: () => void;
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stale = vi.fn<CollectorHandler>(async () => {
    await finish;
    return succeed();
  });
  const leader = start(stale);
  try {
    await vi.waitFor(async () =>
      expect((await row(id)).lastStatus).toBe('running'),
    );
    const oldPid = await leaderPid();
    const standby = vi.fn(succeed);
    start(standby);
    await pool.query('select pg_terminate_backend($1)', [oldPid]);
    leader.stop.abort();
    await vi.waitFor(async () => {
      expect(await leaderPid()).toBeDefined();
      expect(await leaderPid()).not.toBe(oldPid);
    });
    expect((await request(requestId)).state).toBe('running');
    expect(standby).not.toHaveBeenCalled();
    time += 10 * minute;
    await wake();
    await vi.waitFor(async () =>
      expect((await request(requestId)).state).toBe('done'),
    );
    expect(standby).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await leader.done;
  }
  expect(await db.select().from(captures)).toHaveLength(1);
});

it('finishes the current capture during shutdown and leaves the next row due', async () => {
  const first = await schedule({ nextDueAt: new Date(time - 1) });
  const second = await schedule();
  let release!: () => void;
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = vi.fn<CollectorHandler>(async (_, signal) => {
    await finish;
    expect(signal.aborted).toBe(false);
    return succeed();
  });
  const worker = start(handler);
  try {
    await vi.waitFor(async () =>
      expect((await row(first)).lastStatus).toBe('running'),
    );
    worker.stop.abort();
  } finally {
    release();
    await worker.done;
  }
  expect((await row(first)).lastStatus).toBe('succeeded');
  expect((await row(second)).lastStartedAt).toBeNull();
  expect(handler).toHaveBeenCalledTimes(1);
});

it('rolls back a rejected capture and finishes its manual attempt as failed', async () => {
  const id = await schedule();
  const requestId = await enqueueRunRequest(pool, null);
  const handle: CollectorHandler = async () => ({
    status: 'success',
    capture: {
      capturedAt: now(),
      reportedTotal: 1,
      fetched: 1,
      complete: true,
      slices: 1,
      durationMs: 0,
      listings: [
        {
          itemId: 'invalid-price',
          seller: null,
          fingerprint: null,
          price: { amount: 'non-numeric', currency: 'chaos' },
          priceChaos: null,
          indexedAt: null,
          item: {},
        },
      ],
    },
  });
  start(handle);
  await vi.waitFor(async () =>
    expect((await request(requestId)).state).toBe('failed'),
  );
  expect((await request(requestId)).summary).toEqual({
    pending: [],
    succeeded: 0,
    failed: 1,
  });
  expect(await row(id)).toMatchObject({
    lastStatus: 'failed',
    lastError: 'CAPTURE_PERSISTENCE_FAILED',
    retryAt: new Date(initial + minute),
  });
  expect(await db.select().from(captures)).toHaveLength(0);
});

it('keeps cron cadence and defers only Trade during a shared rate-limit window', async () => {
  const trade = await schedule();
  const maintenance = await schedule({
    kind: 'retention',
    payload: { cron: '15 2 * * *', timezone: 'Europe/Warsaw' },
  });
  const policy = 'trade-fetch-request-limit';
  await pool.query(
    'insert into rate_limit_states (policy, blocked_until) values ($1, $2)',
    [policy, new Date(initial + 5 * minute)],
  );
  const handler = vi.fn<CollectorHandler>(async (target) =>
    target.kind === 'trade-target' ? succeed() : { status: 'success' },
  );
  const worker = start(handler);
  try {
    await vi.waitFor(async () =>
      expect((await row(maintenance)).lastStatus).toBe('succeeded'),
    );
    expect((await row(maintenance)).nextDueAt.toISOString()).toBe(
      '2026-11-10T01:15:00.000Z',
    );
    expect((await row(trade)).lastStartedAt).toBeNull();
    time += 5 * minute;
    await wake();
    await vi.waitFor(async () =>
      expect((await row(trade)).lastStatus).toBe('succeeded'),
    );
  } finally {
    worker.stop.abort();
    await worker.done;
    await pool.query('delete from rate_limit_states where policy = $1', [
      policy,
    ]);
  }
});

it('retries leader bootstrap before consuming an offline manual request', async () => {
  const requestId = await enqueueRunRequest(pool, null);
  const id = randomUUID();
  const bootstrap = vi.fn(async (client: PoolClient) => {
    expect((await request(requestId)).state).toBe('queued');
    if (bootstrap.mock.calls.length === 1)
      throw new Error('prerequisite unavailable');
    await drizzle({ client })
      .insert(collectorSchedule)
      .values({
        id,
        kind: 'trade-target',
        key: id,
        payload: {},
        intervalMinutes: 60,
        nextDueAt: new Date(time + 60 * minute),
      });
  });
  start(succeed, 25, bootstrap);
  await vi.waitFor(async () =>
    expect((await request(requestId)).state).toBe('done'),
  );
  expect(bootstrap).toHaveBeenCalledTimes(2);
  expect((await row(id)).lastStatus).toBe('succeeded');
});

it('reports a manual request with no eligible targets as unavailable', async () => {
  const requestId = await enqueueRunRequest(pool, null);
  const handler = vi.fn(succeed);
  start(handler);
  await vi.waitFor(async () =>
    expect((await request(requestId)).state).toBe('failed'),
  );
  expect((await request(requestId)).summary).toMatchObject({
    error: 'COLLECTOR_NO_ELIGIBLE_TARGETS',
  });
  expect(handler).not.toHaveBeenCalled();
});

it('fences a stale league activation on the terminated leader session', async () => {
  const id = await schedule({ kind: 'league' });
  const repositories = createPostgresRepositories(pool);
  const league = await repositories.leagues.upsert({
    game: 'poe1',
    realm: 'pc',
    gggId: randomUUID(),
    name: 'Collector fence test',
    startAt: null,
    endAt: null,
    isCurrent: false,
    syncedAt: now(),
    metadata: {},
  });
  let release!: () => void;
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  const activate = vi.fn(async (client: PoolClient) =>
    createPostgresRepositories(pool, client).leagues.setCurrent(
      league.id,
      now(),
    ),
  );
  const worker = start(async (_, _signal, client) => {
    await finish;
    await activate(client);
    return { status: 'success' };
  });
  try {
    await vi.waitFor(async () =>
      expect((await row(id)).lastStatus).toBe('running'),
    );
    await pool.query('select pg_terminate_backend($1)', [await leaderPid()]);
    worker.stop.abort();
    release();
    await worker.done;
    expect(activate).toHaveBeenCalledTimes(1);
    await expect(activate.mock.results[0]!.value).rejects.toThrow();
    expect(
      (await repositories.leagues.list()).find(({ id }) => id === league.id)
        ?.isCurrent,
    ).toBe(false);
  } finally {
    worker.stop.abort();
    release();
    await worker.done;
    await pool.query('delete from poe_leagues where id = $1', [league.id]);
  }
});

it('keeps a Trade auth block through cooldown and allows one recovery per manual request', async () => {
  const id = await schedule();
  const blocked = {
    status: 'blocked',
    reason: 'PROVIDER_AUTH_FAILED',
  } as const;
  const policy = 'trade-fetch-request-limit';
  const handler = vi
    .fn<CollectorHandler>()
    .mockResolvedValueOnce(blocked)
    .mockImplementationOnce(async () => {
      const retryAt = new Date(initial + 2 * minute);
      await pool.query(
        'update rate_limit_states set blocked_until = $2, last_status = 429 where policy = $1',
        [policy, retryAt],
      );
      return { status: 'retry', reason: 'PROVIDER_RATE_LIMITED', retryAt };
    })
    .mockImplementation(succeed);
  const readBlock = async () =>
    (await db.select().from(collectorState))[0]?.blockedReason;
  const worker = start(handler);
  try {
    await vi.waitFor(async () =>
      expect(await readBlock()).toBe(blocked.reason),
    );
    const sibling = await schedule();
    await pool.query(
      'insert into rate_limit_states (policy, blocked_until) values ($1, $2)',
      [policy, new Date(initial + minute)],
    );
    const first = await enqueueRunRequest(pool, null);
    await vi.waitFor(async () =>
      expect((await request(first)).state).toBe('running'),
    );
    expect(await readBlock()).toBe(blocked.reason);
    expect(handler).toHaveBeenCalledOnce();
    time += minute;
    await wake();
    await vi.waitFor(async () =>
      expect((await request(first)).state).toBe('failed'),
    );
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[3]).toBe(true);
    expect(await readBlock()).toBe(blocked.reason);
    const second = await enqueueRunRequest(pool, null);
    await vi.waitFor(async () =>
      expect((await request(second)).state).toBe('running'),
    );
    expect(handler).toHaveBeenCalledTimes(2);
    time += minute;
    await wake();
    await vi.waitFor(async () =>
      expect((await request(second)).state).toBe('done'),
    );
    expect((await db.select().from(collectorState))[0]).toMatchObject({
      blockedReason: null,
      sessionCheckedAt: now(),
    });
    expect((await row(id)).lastStatus).toBe('succeeded');
    expect((await row(sibling)).lastStatus).toBe('succeeded');
  } finally {
    worker.stop.abort();
    await worker.done;
    await pool.query('delete from rate_limit_states where policy = $1', [
      policy,
    ]);
  }
});

it('stores collector rate windows without retaining a shared auth denial', async () => {
  const policy = 'test-p2-08-rate-policy';
  const repository = createPostgresRepositories(pool).rateLimits;
  const gate = new GggRateLimitController({ repository, clock: now });
  const headers = new Headers({
    'x-rate-limit-policy': policy,
    'retry-after': '120',
  });
  const denial = { status: 403, headers };
  try {
    expect(
      await gate.observeResponse('trade-search', denial, { collector: true }),
    ).toMatchObject({
      blockedUntil: new Date(initial + 2 * minute),
      lastStatus: null,
    });
    await expect(
      gate.waitForPermit('trade-fetch', undefined, {
        collector: true,
        deferProviderBlock: true,
      }),
    ).rejects.toMatchObject({ retryAt: new Date(initial + 2 * minute) });
    await gate.observeResponse('trade-search', denial);
    expect(
      await gate.observeResponse(
        'trade-search',
        { status: 200, headers },
        { collector: true },
      ),
    ).toMatchObject({ lastStatus: 403 });
    await expect(gate.waitForPermit('trade-search')).rejects.toMatchObject({
      code: 'MARKET_ACCESS_BLOCKED',
    });
  } finally {
    await pool.query(
      'delete from rate_limit_endpoint_policies where policy = $1',
      [policy],
    );
    await pool.query('delete from rate_limit_states where policy = $1', [
      policy,
    ]);
  }
});

it('keeps a manual auth recovery pending until the login policy allows it', async () => {
  await schedule();
  await db
    .insert(collectorState)
    .values({ id: 1, blockedReason: 'PROVIDER_AUTH_FAILED' });
  const gate = new GggRateLimitController({
    repository: createPostgresRepositories(pool).rateLimits,
    clock: now,
  });
  const { blockedUntil } = await gate.observeResponse(
    'trade-login',
    {
      status: 429,
      headers: new Headers({ 'retry-after': '120' }),
    },
    { collector: true },
  );
  const id = await enqueueRunRequest(pool, null);
  const handler = vi.fn(succeed);
  start(handler);
  await vi.waitFor(async () => {
    expect((await request(id)).summary).toMatchObject({
      recoverTradeAuthentication: true,
    });
  });
  expect((await readCollectorQueue(pool, now())).nextDueAt).toEqual(
    blockedUntil,
  );
  expect(handler).not.toHaveBeenCalled();
  time = blockedUntil.getTime() + 1000;
  await wake();
  await vi.waitFor(async () => expect((await request(id)).state).toBe('done'));
  expect(handler.mock.calls).toHaveLength(1);
});

it('does not repeat a claimed manual recovery after losing leadership', async () => {
  const id = await schedule();
  const sibling = await schedule();
  await db
    .insert(collectorState)
    .values({ id: 1, blockedReason: 'PROVIDER_AUTH_FAILED' });
  const requestId = await enqueueRunRequest(pool, null);
  const handler = vi.fn<CollectorHandler>(async (_, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    return succeed();
  });
  const leader = start(handler);
  await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  expect(handler.mock.calls[0]?.[3]).toBe(true);
  expect((await request(requestId)).summary).not.toHaveProperty(
    'recoverTradeAuthentication',
  );
  const originalPid = await leaderPid();
  const standby = vi.fn(succeed);
  start(standby);
  await pool.query('select pg_terminate_backend($1)', [originalPid]);
  leader.stop.abort();
  await vi.waitFor(async () =>
    expect((await request(requestId)).state).toBe('failed'),
  );
  expect(standby).not.toHaveBeenCalled();
  expect(
    [await row(id), await row(sibling)].filter(
      (target) => target.lastStartedAt !== null,
    ),
  ).toHaveLength(1);
  expect((await db.select().from(collectorState))[0]?.blockedReason).toBe(
    'PROVIDER_AUTH_FAILED',
  );
});

it('pauses collection and resumes via a notification', async () => {
  const due = await schedule();
  const maintenance = await schedule({ kind: 'league' });
  await pool.query(
    'insert into market_admin_settings (id, settings) values (1, $1::jsonb) on conflict (id) do update set settings = excluded.settings',
    [JSON.stringify({ collectionsPaused: true })],
  );
  try {
    start(async ({ kind }) =>
      kind === 'league' ? { status: 'success' } : succeed(),
    );
    await vi.waitFor(async () =>
      expect((await row(maintenance)).lastStatus).toBe('succeeded'),
    );
    expect((await row(due)).lastStartedAt).toBeNull();
    await pool.query('delete from market_admin_settings where id = 1');
    await wake();
    await vi.waitFor(async () =>
      expect((await row(due)).lastStatus).toBe('succeeded'),
    );
  } finally {
    await pool.query('delete from market_admin_settings where id = 1');
  }
});

it('leaves discovery cadence untouched by a manual recipe refresh', async () => {
  const normal = await schedule();
  const research = await schedule({
    payload: { discovery: true },
    nextDueAt: new Date(time + 30 * minute),
  });
  const requestId = await enqueueRunRequest(pool, null);
  start(succeed);
  await vi.waitFor(async () =>
    expect((await request(requestId)).state).toBe('done'),
  );
  expect((await row(normal)).lastStatus).toBe('succeeded');
  expect((await row(research)).lastStartedAt).toBeNull();
  expect((await row(research)).nextDueAt.getTime()).toBe(time + 30 * minute);
});

it('persists HA measurements, reuses the in-flight request, and reports incomplete coverage', async () => {
  expect(
    (await readCollectorDiagnostics(pool, now())).windows[0]?.trackedSince,
  ).toBeNull();
  const id = await schedule({ nextDueAt: new Date(time + minute) });
  const telemetry = new CollectorTelemetry({ now });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = async () => {
    const send = telemetry.fetch(
      'ggg',
      'trade-search',
      async () =>
        new Response('redacted', {
          status: 429,
          headers: { 'retry-after': '120', 'x-secret': 'sensitive-token' },
        }),
    );
    await send('https://www.pathofexile.com/?private=sensitive-query');
    telemetry.recordResponse('ggg', 'trade-fetch', 200);
    await waiting;
    return succeed();
  };
  const stop = new AbortController();
  const done = runCollector({
    pool,
    signal: stop.signal,
    now,
    telemetry,
    maxIdleMs: 50,
    handlers: {
      'trade-target': handler,
      economy: handler,
      league: handler,
      retention: handler,
    },
  });
  workers.push({ stop, done });
  const requestId = await enqueueRunRequest(pool, null);
  try {
    await vi.waitFor(async () => {
      expect(
        (await readCollectorDiagnostics(pool, now())).current?.taskStartedAt,
      ).not.toBeNull();
    });
    expect(await enqueueRunRequest(pool, null)).toBe(requestId);
    release();
    await vi.waitFor(async () =>
      expect((await request(requestId)).state).toBe('done'),
    );
    const view = await readCollectorDiagnostics(pool, now());
    expect(view).toMatchObject({ role: 'leader', stale: false });
    expect(view.windows[0]).toMatchObject({
      trackedSince: now().toISOString(),
      requests: [
        { provider: 'ggg', endpoint: 'trade-search', rateLimited: 1 },
        { provider: 'ggg', endpoint: 'trade-fetch', success: 1 },
      ],
      last429: { at: now().toISOString(), retryAfterMs: 120_000 },
      captures: {
        planned: 1,
        successful: 1,
        complete: 1,
        failed: 0,
        searchRequests: { average: 1, max: 1 },
      },
    });
    expect(JSON.stringify(view)).not.toMatch(/sensitive-(token|query)/);
    expect((await row(id)).lastStatus).toBe('succeeded');
  } finally {
    release();
    stop.abort();
    await done;
  }
  expect(await readCollectorDiagnostics(pool, now())).toMatchObject({
    role: 'offline',
    current: null,
    stale: true,
  });
});
