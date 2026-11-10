import type { RecipeDetailView } from '@poe-worksmith/contracts';
import {
  activityLookbackMs,
  staleAskAgeMs,
  summarizeMarketActivity,
  type ActivityEvent,
  type ActivityListing,
} from '@poe-worksmith/domain';
import { and, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

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
export const listingLimit = 5000;
export const eventLimit = 20_000;
export const captureLimit = 512;

/** Reads one trade target's activity; `scheduleKey` is its market query hash. */
export function createMarketActivityReader(
  pool: Pool | PoolClient,
): MarketActivityReader {
  const db = drizzle({ client: pool });
  return (leagueId, scheduleKey, now, maximumQuoteAgeMs) =>
    db.transaction(
      async (transaction) => {
        const [schedule] = await transaction
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
        const captureRows = await transaction
          .select({
            id: captures.id,
            capturedAt: captures.capturedAt,
            complete: captures.complete,
            floorChaos: captures.floorChaos,
            queryVersion: captures.queryVersion,
            sortedSampleIds: captures.sortedSampleIds,
          })
          .from(captures)
          .where(
            and(
              eq(captures.scheduleId, schedule.id),
              gte(captures.capturedAt, since),
              or(
                eq(captures.queryVersion, scheduleKey),
                isNull(captures.queryVersion),
              ),
            ),
          )
          .orderBy(desc(captures.capturedAt))
          .limit(captureLimit + 1);
        // Listing rows are mutable. A newer capture makes an as-of read unsafe.
        if (captureRows[0] && captureRows[0].capturedAt > now) return null;
        // ponytail: scans the schedule's listings by primary-key prefix; add a
        // (schedule_id, last_seen_at) index if old gone rows make this slow.
        const listingRows = await transaction
          .select({
            itemId: listings.itemId,
            seller: listings.seller,
            fingerprint: listings.fingerprint,
            priceChaos: listings.priceChaos,
            firstSeenAt: listings.firstSeenAt,
            lastSeenAt: listings.lastSeenAt,
            lastCaptureId: listings.lastCaptureId,
            status: listings.status,
            goneAt: listings.goneAt,
            unchangedAskSince: listings.unchangedAskSince,
          })
          .from(listings)
          .where(
            and(
              eq(listings.scheduleId, schedule.id),
              or(gte(listings.lastSeenAt, since), gte(listings.goneAt, since)),
            ),
          )
          .limit(listingLimit + 1);
        const eventRows = await transaction
          .select({
            itemId: listingEvents.itemId,
            at: listingEvents.at,
            type: listingEvents.type,
            relatedItemId: listingEvents.relatedItemId,
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
              lte(listingEvents.at, now),
            ),
          )
          .limit(eventLimit + 1);
        return summarizeCaptureActivity({
          captureRows,
          listingRows: listingRows as CaptureActivityListing[],
          eventRows: eventRows as ActivityEvent[],
          scheduleKey,
          now,
          maximumQuoteAgeMs,
        });
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
}

type CaptureActivityListing = ActivityListing & {
  unchangedAskSince: Date | null;
};

/** The caller supplies one exact target and a coherent snapshot, newest capture first. */
export function summarizeCaptureActivity(input: {
  captureRows: readonly Pick<
    typeof captures.$inferSelect,
    | 'id'
    | 'capturedAt'
    | 'complete'
    | 'floorChaos'
    | 'queryVersion'
    | 'sortedSampleIds'
  >[];
  listingRows: readonly CaptureActivityListing[];
  eventRows: readonly ActivityEvent[];
  scheduleKey: string;
  now: Date;
  maximumQuoteAgeMs?: number | undefined;
}): MarketActivityView | null {
  const {
    captureRows,
    listingRows,
    eventRows,
    scheduleKey,
    now,
    maximumQuoteAgeMs,
  } = input;
  const since = now.getTime() - activityLookbackMs;
  if (
    captureRows.length > captureLimit ||
    listingRows.length > listingLimit ||
    eventRows.length > eventLimit
  )
    return null;

  const [latest] = captureRows;
  const completeCaptureFloors = new Map<string, string>();
  for (const capture of captureRows) {
    if (capture.queryVersion === scheduleKey && capture.floorChaos !== null)
      completeCaptureFloors.set(capture.id, capture.floorChaos);
  }

  const oldestUsable = Math.max(
    since,
    now.getTime() - (maximumQuoteAgeMs ?? activityLookbackMs),
  );
  const freshCapture =
    latest &&
    latest.capturedAt.getTime() >= oldestUsable &&
    latest.capturedAt <= now
      ? latest
      : undefined;
  const covered =
    freshCapture?.complete && freshCapture.sortedSampleIds === null;
  const { recentExitAskChaos, ...counts } = summarizeMarketActivity({
    listings: listingRows,
    events: eventRows,
    latestCompleteCaptureId: covered ? freshCapture.id : null,
    completeCaptureFloors,
    now,
  });
  const observedAsks = freshCapture
    ? listingRows
        .flatMap(({ lastCaptureId, priceChaos, status, unchangedAskSince }) =>
          lastCaptureId === freshCapture.id &&
          status === 'active' &&
          priceChaos !== null
            ? [
                {
                  amount: Number(priceChaos),
                  stale:
                    unchangedAskSince !== null &&
                    freshCapture.capturedAt.getTime() -
                      unchangedAskSince.getTime() >=
                      staleAskAgeMs,
                },
              ]
            : [],
        )
        .sort((a, b) => a.amount - b.amount)
    : [];
  const ask = (amount: number) => ({ amount, currency: 'chaos' as const });
  const staleAskCount =
    freshCapture?.queryVersion === scheduleKey
      ? observedAsks.filter(({ stale }) => stale).length
      : null;
  return {
    ...counts,
    inferredExits24h: completeCaptureFloors.size
      ? counts.inferredExits24h
      : null,
    inferredExits72h: completeCaptureFloors.size
      ? counts.inferredExits72h
      : null,
    capturedAt: latest?.capturedAt.toISOString() ?? null,
    observedAskSample: observedAsks
      .slice(0, 5)
      .map(({ amount }) => ask(amount)),
    staleAskCount,
    staleFloorCount:
      staleAskCount === null
        ? null
        : observedAsks.filter(
            ({ stale, amount }) => stale && amount === observedAsks[0]?.amount,
          ).length,
    observedFloorWithoutStaleAsks: staleAskCount
      ? (observedAsks.find(({ stale }) => !stale)?.amount ?? null)
      : null,
    recentExitAsk:
      recentExitAskChaos === null
        ? null
        : { amount: Number(recentExitAskChaos), currency: 'chaos' },
  };
}
