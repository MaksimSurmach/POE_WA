import { Decimal } from 'decimal.js';

import type { Listing, ListingEvent } from './captureReducer.js';

const hourMs = 60 * 60 * 1000;
export const activityExitWindowMs = 72 * hourMs;
/** Listings and events are read this far back; older facts count as missing. */
export const activityLookbackMs = 96 * hourMs;
export const exitMissSeparationMs = 2 * hourMs;
export const exitFloorTolerance = '1.2';
export const minimumExitAskObservations = 3;

export type ActivityListing = Pick<
  Listing,
  | 'itemId'
  | 'seller'
  | 'priceChaos'
  | 'firstSeenAt'
  | 'lastSeenAt'
  | 'lastCaptureId'
  | 'status'
  | 'goneAt'
>;
export type ActivityEvent = Pick<ListingEvent, 'itemId' | 'at' | 'type'>;

export type MarketActivity = Readonly<{
  /** Null unless the latest capture covered the whole target. */
  active: number | null;
  distinctSellers: number | null;
  repriced72h: number;
  inferredExits24h: number;
  inferredExits72h: number;
  uncertainExits72h: number;
  /** Median last ask of inferred exits; null below the observation minimum. */
  recentExitAskChaos: string | null;
}>;

/**
 * Classifies one listing that left Trade. Null means it is not an exit
 * (still listed, or relisted). Any missing fact yields `uncertain`.
 */
export function classifyExit(
  listing: ActivityListing,
  events: readonly ActivityEvent[],
  floorAtLastSeen: string | null,
  sellerContext: { otherLastSeenAt: Date | null },
): 'inferred' | 'uncertain' | null {
  const { goneAt } = listing;
  if (listing.status !== 'gone' || goneAt === null) return null;
  if (events.some((row) => row.type === 'possible_relist' && row.at >= goneAt))
    return null;
  const firstMissAt = events
    .filter(
      (row) =>
        row.type === 'missed' && row.at > listing.lastSeenAt && row.at < goneAt,
    )
    .map((row) => row.at.getTime())
    .sort((left, right) => left - right)[0];
  if (
    firstMissAt === undefined ||
    goneAt.getTime() - firstMissAt < exitMissSeparationMs
  )
    return 'uncertain';
  if (listing.priceChaos === null || floorAtLastSeen === null)
    return 'uncertain';
  if (
    new Decimal(listing.priceChaos).gt(
      new Decimal(floorAtLastSeen).mul(exitFloorTolerance),
    )
  )
    return 'uncertain';
  // The seller must have been seen on this target after the listing went missing.
  const seenAt = sellerContext.otherLastSeenAt;
  if (seenAt === null || seenAt.getTime() < firstMissAt) return 'uncertain';
  return 'inferred';
}

/**
 * Summarises one target. `listings` and `events` must hold every row of the
 * schedule at or after `now - activityLookbackMs`.
 */
export function summarizeMarketActivity(input: {
  listings: readonly ActivityListing[];
  events: readonly ActivityEvent[];
  latestCompleteCaptureId: string | null;
  completeCaptureFloors?: ReadonlyMap<string, string>;
  now: Date;
}): MarketActivity {
  const { listings, now } = input;
  const since72 = now.getTime() - activityExitWindowMs;
  const since24 = now.getTime() - 24 * hourMs;
  const events = [...input.events].sort(
    (left, right) => left.at.getTime() - right.at.getTime(),
  );
  const eventsByItem = new Map<string, ActivityEvent[]>();
  for (const row of events) {
    const group = eventsByItem.get(row.itemId);
    if (group) group.push(row);
    else eventsByItem.set(row.itemId, [row]);
  }

  const sellerLatest = new Map<string, Date>();
  for (const row of listings) {
    const seller = row.seller?.trim();
    if (seller && row.lastSeenAt > (sellerLatest.get(seller) ?? new Date(0)))
      sellerLatest.set(seller, row.lastSeenAt);
  }

  let inferredExits24h = 0;
  let uncertainExits72h = 0;
  const exitAsks: Decimal[] = [];
  for (const row of listings) {
    if (
      row.goneAt === null ||
      row.goneAt.getTime() < since72 ||
      row.goneAt > now
    )
      continue;
    const seller = row.seller?.trim();
    const otherLastSeenAt = seller ? (sellerLatest.get(seller) ?? null) : null;
    const kind = classifyExit(
      row,
      eventsByItem.get(row.itemId) ?? [],
      input.completeCaptureFloors?.get(row.lastCaptureId) ?? null,
      { otherLastSeenAt },
    );
    if (kind === 'uncertain') uncertainExits72h += 1;
    if (kind !== 'inferred') continue;
    exitAsks.push(new Decimal(row.priceChaos!));
    if (row.goneAt.getTime() >= since24) inferredExits24h += 1;
  }

  exitAsks.sort((left, right) => left.cmp(right));
  const middle = exitAsks.length >> 1;
  const recentExitAskChaos =
    exitAsks.length < minimumExitAskObservations
      ? null
      : (exitAsks.length % 2
          ? exitAsks[middle]!
          : exitAsks[middle - 1]!.add(exitAsks[middle]!).div(2)
        ).toString();

  const active =
    input.latestCompleteCaptureId === null
      ? null
      : listings.filter(
          (row) =>
            row.status === 'active' &&
            row.lastCaptureId === input.latestCompleteCaptureId,
        );
  return {
    active: active?.length ?? null,
    distinctSellers: active
      ? new Set(active.flatMap((row) => (row.seller ? [row.seller] : []))).size
      : null,
    repriced72h: new Set(
      events
        .filter(
          (row) => row.type === 'price_changed' && row.at.getTime() >= since72,
        )
        .map((row) => row.itemId),
    ).size,
    inferredExits24h,
    inferredExits72h: exitAsks.length,
    uncertainExits72h,
    recentExitAskChaos,
  };
}
