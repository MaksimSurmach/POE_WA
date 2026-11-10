import {
  applyCapture,
  captureRelistWindowMs,
  outcomeMoney,
  type Capture,
  type Listing,
} from '@poe-worksmith/domain';
import {
  and,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

import {
  captures,
  collectorSchedule,
  listingEvents,
  listings,
} from '../schema.js';
import {
  mapRepositoryError,
  RepositoryConflictError,
  RepositoryNotFoundError,
} from './errors.js';

export type CaptureInput = Omit<typeof captures.$inferInsert, 'id'> & {
  listings: Capture['listings'];
};

// A complete capture may change more rows than the fetch limit.
const batchSize = 1000;

function storagePrice(value: string) {
  if (!Number.isFinite(Number(value)))
    throw new Error('Capture price must be finite');
  return outcomeMoney(value);
}

/** The caller must hold an open read-committed transaction on this client. */
export async function writeCaptureInTransaction(
  client: PoolClient,
  input: CaptureInput,
) {
  const { listings: sightings, ...metadata } = input;
  const { scheduleId, capturedAt } = metadata;
  const db = drizzle({ client });
  // Wait for the preceding capture before reading its listing state.
  const [schedule] = await db
    .select({ id: collectorSchedule.id })
    .from(collectorSchedule)
    .where(eq(collectorSchedule.id, scheduleId))
    .for('update');
  if (!schedule) throw new RepositoryNotFoundError('captures', 'saveCapture');

  const [capture] = await db
    .insert(captures)
    .values(metadata)
    .returning({ id: captures.id });
  if (!capture) throw new Error('Capture insert returned no ID');
  const [newer] = await db
    .select({ id: captures.id })
    .from(captures)
    .where(
      and(
        eq(captures.scheduleId, scheduleId),
        gt(captures.capturedAt, capturedAt),
      ),
    )
    .limit(1);
  if (newer)
    throw new RepositoryConflictError(
      'captures',
      'saveCapture',
      new Error('A newer capture already exists for this schedule'),
    );

  const relistSince = new Date(capturedAt.getTime() - captureRelistWindowMs);
  const previous = (await db
    .select({
      ...getTableColumns(listings),
      // Existing item payloads stay in PostgreSQL because the upsert preserves them.
      item: sql<Listing['item']>`'{}'::jsonb`,
    })
    .from(listings)
    .where(
      and(
        eq(listings.scheduleId, scheduleId),
        or(
          ne(listings.status, 'gone'),
          gte(listings.goneAt, relistSince),
          // An old ID can reappear even after its relist window closes.
          inArray(
            listings.itemId,
            sightings.map((row) => row.itemId),
          ),
        ),
      ),
    )) as Listing[];
  const priorById = new Map(previous.map((row) => [row.itemId, row]));
  const next = applyCapture(previous, {
    id: capture.id,
    scheduleId,
    capturedAt,
    complete: metadata.complete,
    listings: sightings.map((row) => ({
      ...row,
      price: row.price && {
        ...row.price,
        amount: storagePrice(row.price.amount),
      },
      priceChaos: row.priceChaos === null ? null : storagePrice(row.priceChaos),
    })),
  });
  const changed = next.listings.filter(
    (row) => priorById.get(row.itemId) !== row,
  );
  for (let offset = 0; offset < changed.length; offset += batchSize) {
    await db
      .insert(listings)
      .values(
        changed.slice(offset, offset + batchSize).map((row) => ({
          ...row,
          item: sql`${row.item}::jsonb`,
        })),
      )
      .onConflictDoUpdate({
        target: [listings.scheduleId, listings.itemId],
        set: {
          seller: sql`excluded.seller`,
          fingerprint: sql`excluded.fingerprint`,
          lastSeenAt: sql`excluded.last_seen_at`,
          lastCaptureId: sql`excluded.last_capture_id`,
          priceOriginal: sql`excluded.price_original`,
          currency: sql`excluded.currency`,
          priceChaos: sql`excluded.price_chaos`,
          indexedAt: sql`excluded.indexed_at`,
          status: sql`excluded.status`,
          missedCompleteCaptures: sql`excluded.missed_complete_captures`,
          goneAt: sql`excluded.gone_at`,
        },
      });
  }
  for (let offset = 0; offset < next.events.length; offset += batchSize)
    await db
      .insert(listingEvents)
      .values(next.events.slice(offset, offset + batchSize));
  return capture.id;
}

/** A caller-owned client must be idle and used serially; its caller manages its lifecycle. */
export function createCaptureRepository(connection: Pool | PoolClient) {
  return {
    saveCapture(input: CaptureInput) {
      return mapRepositoryError('captures', 'saveCapture', async () => {
        const ownsClient = !('release' in connection);
        const client = ownsClient ? await connection.connect() : connection;
        let discardClient = false;
        const markFailed = () => {
          discardClient = true;
        };
        client.on('error', markFailed);
        try {
          await client.query('begin isolation level read committed');
          const id = await writeCaptureInTransaction(client, input);
          await client.query('commit');
          return id;
        } catch (error) {
          await client.query('rollback').catch(markFailed);
          throw error;
        } finally {
          client.off('error', markFailed);
          if (ownsClient) client.release(discardClient);
        }
      });
    },
  };
}
