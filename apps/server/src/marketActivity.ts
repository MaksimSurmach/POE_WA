import type { RecipeDetailView } from '@poe-worksmith/contracts';
import {
  activityLookbackMs,
  summarizeMarketActivity,
  type ActivityEvent,
  type ActivityListing,
} from '@poe-worksmith/domain';
import { and, desc, eq, gte, inArray, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import {
  captures,
  collectorSchedule,
  listingEvents,
  listings,
} from './schema.js';

export type MarketActivityView = NonNullable<
  RecipeDetailView['marketActivity']
>;
export type MarketActivityReader = (
  leagueId: string,
  scheduleKey: string,
  now: Date,
  maximumQuoteAgeMs?: number,
) => Promise<MarketActivityView | null>;

// Beyond these the window is not fully read, so the reader abstains.
const listingLimit = 5000;
const eventLimit = 20_000;
const captureLimit = 512;

/** Reads one trade target's activity; `scheduleKey` is its market query hash. */
export function createMarketActivityReader(pool: Pool): MarketActivityReader {
  const db = drizzle({ client: pool });
  return async (leagueId, scheduleKey, now, maximumQuoteAgeMs) => {
    const [schedule] = await db
      .select({ id: collectorSchedule.id })
      .from(collectorSchedule)
      .where(
        and(
          eq(collectorSchedule.kind, 'trade-target'),
          eq(collectorSchedule.key, scheduleKey),
          eq(collectorSchedule.leagueId, leagueId),
          eq(collectorSchedule.enabled, true),
        ),
      )
      .limit(1);
    if (!schedule) return null;

    const since = new Date(now.getTime() - activityLookbackMs);
    const [captureRows, listingRows, eventRows] = await Promise.all([
      db
        .select({
          id: captures.id,
          capturedAt: captures.capturedAt,
          complete: captures.complete,
          fetched: captures.fetched,
          sortedSampleIds: captures.sortedSampleIds,
        })
        .from(captures)
        .where(
          and(
            eq(captures.scheduleId, schedule.id),
            gte(captures.capturedAt, since),
          ),
        )
        .orderBy(desc(captures.capturedAt))
        .limit(captureLimit),
      // ponytail: scans the schedule's listings by primary-key prefix; add a
      // (schedule_id, last_seen_at) index if old gone rows make this slow.
      db
        .select({
          itemId: listings.itemId,
          seller: listings.seller,
          priceChaos: listings.priceChaos,
          firstSeenAt: listings.firstSeenAt,
          lastSeenAt: listings.lastSeenAt,
          lastCaptureId: listings.lastCaptureId,
          status: listings.status,
          goneAt: listings.goneAt,
        })
        .from(listings)
        .where(
          and(
            eq(listings.scheduleId, schedule.id),
            or(gte(listings.lastSeenAt, since), gte(listings.goneAt, since)),
          ),
        )
        .limit(listingLimit + 1),
      db
        .select({
          itemId: listingEvents.itemId,
          at: listingEvents.at,
          type: listingEvents.type,
        })
        .from(listingEvents)
        .where(
          and(
            eq(listingEvents.scheduleId, schedule.id),
            inArray(listingEvents.type, [
              'price_changed',
              'missed',
              'possible_relist',
            ]),
            gte(listingEvents.at, since),
          ),
        )
        .limit(eventLimit + 1),
    ]);
    if (listingRows.length > listingLimit || eventRows.length > eventLimit)
      return null;

    const [latest] = captureRows;
    const byCapture = new Map<
      string,
      { count: number; priced: number; floor: string | null }
    >();
    for (const row of listingRows) {
      const group = byCapture.get(row.lastCaptureId) ?? {
        count: 0,
        priced: 0,
        floor: null,
      };
      group.count++;
      if (row.priceChaos !== null) {
        const price = row.priceChaos;
        group.priced++;
        if (group.floor === null || Number(price) < Number(group.floor))
          group.floor = price;
      }
      byCapture.set(row.lastCaptureId, group);
    }
    const completeCaptureFloors = new Map<string, string>();
    for (const capture of captureRows) {
      const group = byCapture.get(capture.id);
      // Later sightings overwrite lastCaptureId. A floor needs the complete original cohort.
      if (
        capture.complete &&
        capture.sortedSampleIds === null &&
        group?.floor &&
        group.count === capture.fetched &&
        group.priced === capture.fetched
      )
        completeCaptureFloors.set(capture.id, group.floor);
    }

    const oldestUsable = Math.max(
      since.getTime(),
      now.getTime() - (maximumQuoteAgeMs ?? activityLookbackMs),
    );
    const covered =
      latest !== undefined &&
      latest.complete &&
      latest.sortedSampleIds === null &&
      latest.capturedAt.getTime() >= oldestUsable &&
      latest.capturedAt <= now;
    const { recentExitAskChaos, ...counts } = summarizeMarketActivity({
      listings: listingRows as ActivityListing[],
      events: eventRows as ActivityEvent[],
      latestCompleteCaptureId: covered ? latest.id : null,
      completeCaptureFloors,
      now,
    });
    return {
      ...counts,
      capturedAt: latest?.capturedAt.toISOString() ?? null,
      recentExitAsk:
        recentExitAskChaos === null
          ? null
          : { amount: Number(recentExitAskChaos), currency: 'chaos' },
    };
  };
}
