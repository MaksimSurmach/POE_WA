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
import type { PoolClient } from 'pg';
import { createPostgresRepositories } from './repositories/index.js';
import { enqueueRunRequest } from './repositories/runRequestRepository.js';
import { captures, collectorSchedule, runRequests } from './schema.js';

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

beforeEach(() => {
  time = initial;
});

afterEach(async () => {
  for (const worker of workers) worker.stop.abort();
  await Promise.all(workers.splice(0).map(({ done }) => done));
  await pool.query(
    'truncate listing_events, listings, captures, collector_schedule, run_requests, collector_state',
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
    attempt: 3,
    leasedUntil: null,
    retryAt: new Date(initial + 4 * minute),
  });
  time += 4 * minute;
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
