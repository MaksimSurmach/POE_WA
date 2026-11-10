import { randomUUID } from 'node:crypto';
import type { CaptureListing } from '@poe-worksmith/domain';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, afterEach, expect, it } from 'vitest';

import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import {
  captures,
  collectorSchedule,
  listingEvents,
  listings,
} from '../schema.js';
import { createCaptureRepository } from './captureRepository.js';

const config = loadDatabaseConfig();
const address = new URL(config.connectionString);
if (
  config.environment !== 'test' ||
  address.pathname !== '/poe_worksmith_test' ||
  !['localhost', '127.0.0.1', '[::1]', 'postgres-test'].includes(
    address.hostname,
  )
) {
  throw new Error(
    'Capture integration requires isolated local poe_worksmith_test',
  );
}
const pool = createDatabasePool(config);
const db = drizzle({ client: pool });
const repository = createCaptureRepository(pool);

afterEach(async () => {
  await pool.query(
    'truncate listing_events, listings, captures, collector_schedule',
  );
});
afterAll(() => pool.end());

async function schedule() {
  const id = randomUUID();
  await db.insert(collectorSchedule).values({
    id,
    kind: 'trade-target',
    key: id,
    payload: {},
    intervalMinutes: 60,
    nextDueAt: new Date('2026-11-09T12:00:00Z'),
  });
  return id;
}

function listing(
  itemId: string,
  amount: string,
  marker = 'original',
): CaptureListing {
  return {
    itemId,
    seller: 'seller',
    fingerprint: itemId,
    price: { amount, currency: 'chaos' },
    priceChaos: amount,
    indexedAt: null,
    item: { marker },
  };
}

function capture(
  scheduleId: string,
  minute: number,
  sightings: CaptureListing[],
) {
  return {
    scheduleId,
    capturedAt: new Date(Date.UTC(2026, 10, 9, 12, minute)),
    reportedTotal: sightings.length,
    fetched: sightings.length,
    complete: true,
    slices: 1,
    durationMs: 20,
    listings: sightings,
  };
}

async function readState(scheduleId: string) {
  return {
    captures: await db
      .select()
      .from(captures)
      .where(eq(captures.scheduleId, scheduleId))
      .orderBy(captures.capturedAt),
    listings: await db
      .select()
      .from(listings)
      .where(eq(listings.scheduleId, scheduleId))
      .orderBy(listings.itemId),
    events: await db
      .select()
      .from(listingEvents)
      .where(eq(listingEvents.scheduleId, scheduleId))
      .orderBy(listingEvents.id),
  };
}

it('persists one schedule’s capture, current listings and append-only events', async () => {
  const target = await schedule();
  const other = await schedule();
  const original = {
    ...capture(target, 0, [listing('same-id', '10')]),
    reportedTotal: 7,
    complete: false,
    partialReason: 'fixture limit',
    fxSnapshotId: randomUUID(),
  };
  const firstId = await repository.saveCapture(original);
  await repository.saveCapture(
    capture(other, 0, [listing('same-id', '3'), listing('other-only', '8')]),
  );
  const otherBefore = await readState(other);
  const update = capture(target, 1, [listing('same-id', '12', 'replacement')]);
  const secondId = await repository.saveCapture(update);

  const state = await readState(target);
  expect(state.captures).toMatchObject([
    {
      id: firstId,
      scheduleId: target,
      capturedAt: original.capturedAt,
      complete: false,
      reportedTotal: 7,
      fetched: 1,
      partialReason: 'fixture limit',
      fxSnapshotId: original.fxSnapshotId,
      slices: 1,
      durationMs: 20,
    },
    {
      id: secondId,
      scheduleId: target,
      capturedAt: update.capturedAt,
      complete: true,
    },
  ]);
  expect(state.listings).toMatchObject([
    {
      scheduleId: target,
      itemId: 'same-id',
      firstCaptureId: firstId,
      lastCaptureId: secondId,
      firstSeenAt: original.capturedAt,
      lastSeenAt: update.capturedAt,
      item: { marker: 'original' },
      priceOriginal: '12.00000000',
      status: 'active',
    },
  ]);
  expect(state.events).toMatchObject([
    {
      scheduleId: target,
      itemId: 'same-id',
      captureId: firstId,
      type: 'first_seen',
      at: original.capturedAt,
    },
    {
      scheduleId: target,
      itemId: 'same-id',
      captureId: secondId,
      type: 'price_changed',
      at: update.capturedAt,
      fromPriceChaos: '10.00000000',
      toPriceChaos: '12.00000000',
    },
  ]);
  expect(await readState(other)).toEqual(otherBefore);
});

it('rolls back the capture and listing writes if appending events fails', async () => {
  const target = await schedule();
  await repository.saveCapture(capture(target, 0, [listing('existing', '10')]));
  const before = await readState(target);
  await pool.query(
    "alter table listing_events add constraint capture_test_reject_event check (item_id <> 'reject-event')",
  );
  const update = capture(target, 1, [
    listing('existing', '12'),
    listing('reject-event', '3'),
  ]);
  try {
    await expect(repository.saveCapture(update)).rejects.toMatchObject({
      code: 'conflict',
    });
  } finally {
    await pool.query(
      'alter table listing_events drop constraint capture_test_reject_event',
    );
  }
  expect(await readState(target)).toEqual(before);
  const retryId = await repository.saveCapture(update);
  expect((await readState(target)).captures.map(({ id }) => id)).toEqual([
    before.captures[0]?.id,
    retryId,
  ]);
});

it('rejects concurrent duplicates and older captures without changing history', async () => {
  const target = await schedule();
  const input = capture(target, 1, [listing('existing', '10')]);
  const results = await Promise.allSettled([
    repository.saveCapture(input),
    repository.saveCapture(input),
  ]);
  expect(results).toContainEqual({
    status: 'rejected',
    reason: expect.objectContaining({
      code: 'conflict',
      cause: expect.objectContaining({
        cause: expect.objectContaining({
          constraint: 'captures_schedule_time_uq',
        }),
      }),
    }),
  });
  expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
    1,
  );
  const before = await readState(target);
  expect(before.captures).toHaveLength(1);
  expect(before.events).toHaveLength(1);
  await expect(
    repository.saveCapture(capture(target, 0, [])),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(await readState(target)).toEqual(before);
});

it('compares prices at storage precision and rolls back invalid or overflowing amounts', async () => {
  const target = await schedule();
  const original = listing('precise', '10.123456785');
  const first = await repository.saveCapture(capture(target, 0, [original]));
  const second = await repository.saveCapture(capture(target, 1, [original]));
  const state = await readState(target);
  expect(state.events).toMatchObject([
    { type: 'first_seen', captureId: first },
  ]);
  expect(state.listings).toMatchObject([
    {
      priceOriginal: '10.12345679',
      priceChaos: '10.12345679',
      lastCaptureId: second,
      item: original.item,
    },
  ]);

  for (const amount of ['1000000000000', 'not-a-number', 'NaN']) {
    await expect(
      repository.saveCapture(capture(target, 2, [listing('precise', amount)])),
    ).rejects.toMatchObject({ code: 'failure' });
    expect(await readState(target)).toEqual(state);
  }
});

it('preserves an old gone listing’s identity when the same ID reappears', async () => {
  const target = await schedule();
  const first = capture(target, 0, [
    listing('old-id', '10'),
    listing('unseen-id', '12'),
  ]);
  const firstId = await repository.saveCapture(first);
  await repository.saveCapture(capture(target, 1, []));
  await repository.saveCapture(capture(target, 2, []));
  const before = await readState(target);
  const reappearance = {
    ...capture(target, 0, [listing('old-id', '10', 'replacement')]),
    capturedAt: new Date('2026-11-17T12:00:00Z'),
  };
  const latestId = await repository.saveCapture(reappearance);
  const after = await readState(target);
  expect(after.listings).toEqual([
    expect.objectContaining({
      itemId: 'old-id',
      item: { marker: 'original' },
      firstSeenAt: first.capturedAt,
      firstCaptureId: firstId,
      lastCaptureId: latestId,
      status: 'active',
    }),
    before.listings[1],
  ]);
  expect(after.events.slice(before.events.length)).toMatchObject([
    { itemId: 'old-id', captureId: latestId, type: 'reappeared' },
  ]);
});

async function blockingSession(pid: number) {
  const { rows } = await pool.query<{ pid: number }>(
    'select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
    [pid],
  );
  return rows[0]?.pid;
}

it('waits for the schedule lock on a caller-owned session without a second checkout', async () => {
  const target = await schedule();
  const single = createDatabasePool({ ...config, maxConnections: 1 });
  const pinned = await single.connect();
  const blocker = await pool.connect();
  try {
    await blocker.query('begin');
    // This lock permits FK key-share reads, so a capture insert alone would not wait.
    const { rows } = await blocker.query<{ pid: number }>(
      'select pg_backend_pid() as pid from collector_schedule where id = $1 for no key update',
      [target],
    );
    const pid = rows[0]!.pid;
    const save = createCaptureRepository(pinned).saveCapture(
      capture(target, 0, [listing('pinned', '12')]),
    );
    void save.catch(() => undefined);
    try {
      await expect.poll(() => blockingSession(pid)).toBeTypeOf('number');
    } finally {
      await blocker.query('rollback');
    }
    await expect(save).resolves.toEqual(expect.any(String));
    expect(single.idleCount).toBe(0);
  } finally {
    blocker.release();
    pinned.release();
    await single.end();
  }
});

it('discards a checked-out client whose database connection was terminated', async () => {
  const target = await schedule();
  const blocker = await pool.connect();
  try {
    await blocker.query('begin');
    const { rows } = await blocker.query<{ pid: number }>(
      'select pg_backend_pid() as pid from collector_schedule where id = $1 for no key update',
      [target],
    );
    const input = capture(target, 0, [listing('retry', '12')]);
    const save = repository.saveCapture(input);
    void save.catch(() => undefined);
    try {
      let waiting: number | undefined;
      await expect
        .poll(async () => (waiting = await blockingSession(rows[0]!.pid)))
        .toBeTypeOf('number');
      await pool.query('select pg_terminate_backend($1)', [waiting]);
      await expect(save).rejects.toThrow();
    } finally {
      await blocker.query('rollback');
    }
    expect((await readState(target)).captures).toEqual([]);
    await expect(repository.saveCapture(input)).resolves.toEqual(
      expect.any(String),
    );
  } finally {
    blocker.release();
  }
});
