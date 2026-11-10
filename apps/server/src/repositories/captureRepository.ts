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

export type CaptureInput = Omit<
  typeof captures.$inferInsert,
  'id' | 'queryVersion' | 'floorChaos' | 'observedMinChaos' | 'observedMaxChaos'
> & {
  listings: Capture['listings'];
};

// A complete capture may change more rows than the fetch limit.
const batchSize = 1000;

function storagePrice(value: string) {
  if (!Number.isFinite(Number(value)))
    throw new Error('Capture price must be finite');
  return outcomeMoney(value);
}

// Compare stored 8-decimal amounts without losing precision at the top of numeric(20, 8).
function compareStoragePrices(left: string, right: string) {
  const units = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(8, '0'));
  };
  const a = units(left);
  const b = units(right);
  return a < b ? -1 : a === b ? 0 : 1;
}

/** The caller must hold an open read-committed transaction on this client. */
export async function writeCaptureInTransaction(
  client: PoolClient,
  input: CaptureInput,
) {
  const { listings: sightings, ...metadata } = input;
  const normalized = sightings.map((row) => ({
    ...row,
    price: row.price && {
      ...row.price,
      amount: storagePrice(row.price.amount),
    },
    priceChaos: row.priceChaos === null ? null : storagePrice(row.priceChaos),
  }));
  let observedMinChaos: string | null = null;
  let observedMaxChaos: string | null = null;
  for (const { priceChaos } of normalized) {
    if (priceChaos === null) continue;
    if (
      observedMinChaos === null ||
      compareStoragePrices(priceChaos, observedMinChaos) < 0
    )
      observedMinChaos = priceChaos;
    if (
      observedMaxChaos === null ||
      compareStoragePrices(priceChaos, observedMaxChaos) > 0
    )
      observedMaxChaos = priceChaos;
  }
  const complete =
    metadata.complete &&
    metadata.reportedTotal === metadata.fetched &&
    metadata.fetched === normalized.length &&
    new Set(normalized.map(({ itemId }) => itemId)).size === normalized.length;
  const fullCoverage = complete && metadata.sortedSampleIds == null;
  const { scheduleId, capturedAt } = metadata;
  const db = drizzle({ client });
  // Wait for the preceding capture before reading its listing state.
  const [schedule] = await db
    .select({
      key: collectorSchedule.key,
      intervalMinutes: collectorSchedule.intervalMinutes,
    })
    .from(collectorSchedule)
    .where(eq(collectorSchedule.id, scheduleId))
    .for('update');
  if (!schedule) throw new RepositoryNotFoundError('captures', 'saveCapture');

  const [capture] = await db
    .insert(captures)
    .values({
      ...metadata,
      complete,
      partialReason:
        !complete && metadata.complete
          ? 'CAPTURE_COVERAGE_MISMATCH'
          : metadata.partialReason,
      queryVersion: schedule.key,
      floorChaos:
        fullCoverage &&
        normalized.every(
          ({ priceChaos, price }) =>
            priceChaos !== null &&
            (price?.currency === 'chaos' ||
              (price?.currency === 'divine' &&
                metadata.fxSnapshotId != null &&
                metadata.fxChaosPerDivine != null)),
        )
          ? observedMinChaos
          : null,
      observedMinChaos,
      observedMaxChaos,
    })
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
    complete: fullCoverage,
    maximumAskObservationGapMs: schedule.intervalMinutes * 2 * 60_000,
    listings: normalized,
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
          firstMissingAt: sql`excluded.first_missing_at`,
          unchangedAskSince: sql`excluded.unchanged_ask_since`,
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
