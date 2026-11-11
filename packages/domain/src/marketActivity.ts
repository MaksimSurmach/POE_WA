import { Decimal } from 'decimal.js';

import {
  captureRelistWindowMs,
  exitMissSeparationMs,
  type Listing,
  type ListingEvent,
} from './captureReducer.js';

const hourMs = 60 * 60 * 1000;
export const activityExitWindowMs = 72 * hourMs;
/** Listings and events are read this far back; older facts count as missing. */
export const activityLookbackMs = 96 * hourMs;
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
> &
  Partial<Pick<Listing, 'fingerprint'>>;
export type ActivityEvent = Pick<ListingEvent, 'itemId' | 'at' | 'type'> &
  Partial<Pick<ListingEvent, 'relatedItemId'>>;

export type MarketActivity = Readonly<{
  /** Null unless the latest capture covered the whole target. */
  active: number | null;
  distinctSellers: number | null;
  repriced72h: number;
  repriced24h: number;
  relisted24h: number;
  inferredExits24h: number;
  inferredExitSellers24h: number;
  uncertainExits24h: number;
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
  sellerContext: { otherLastSeenAt: Date | null; ambiguousRelist?: boolean },
): 'inferred' | 'uncertain' | null {
  const { goneAt } = listing;
  if (listing.status !== 'gone' || goneAt === null) return null;
  if (events.some((row) => row.type === 'possible_relist' && row.at >= goneAt))
    return null;
  if (sellerContext.ambiguousRelist) return 'uncertain';
  const firstMissAt = events
    .filter(
      (row) =>
        row.type === 'missed' && row.at > listing.lastSeenAt && row.at < goneAt,
    )
    .map((row) => row.at.getTime())
    .sort((left, right) => right - left)[0];
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
  // The seller must have been seen listing something else after the miss;
  // an offline seller's listings all leave Trade at once.
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
  /** Per gone item id: its seller's latest sighting of another item on any target in the league. */
  sellerSeenElsewhereAt?: ReadonlyMap<string, Date>;
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
  const newestMatchingFirstSeen = new Map<string, number>();
  // Several of one seller's listings leaving after the same capture look like a
  // hidden tab, so only a sighting on this target counts for them.
  const withdrawnTogether = new Map<string, number>();
  for (const row of listings) {
    const seller = row.seller?.trim();
    if (!seller || row.lastSeenAt > now) continue;
    if (row.goneAt !== null) {
      const key = JSON.stringify([seller, row.lastCaptureId]);
      withdrawnTogether.set(key, (withdrawnTogether.get(key) ?? 0) + 1);
    }
    if (row.lastSeenAt > (sellerLatest.get(seller) ?? new Date(0)))
      sellerLatest.set(seller, row.lastSeenAt);
    if (row.fingerprint) {
      const key = JSON.stringify([seller, row.fingerprint]);
      newestMatchingFirstSeen.set(
        key,
        Math.max(
          newestMatchingFirstSeen.get(key) ?? 0,
          row.firstSeenAt.getTime(),
        ),
      );
    }
  }

  let inferredExits24h = 0;
  const inferredExitSellers24h = new Set<string>();
  let uncertainExits24h = 0;
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
    const onTarget = seller ? (sellerLatest.get(seller) ?? null) : null;
    const elsewhere =
      seller &&
      withdrawnTogether.get(JSON.stringify([seller, row.lastCaptureId])) === 1
        ? input.sellerSeenElsewhereAt?.get(row.itemId)
        : undefined;
    const otherLastSeenAt =
      elsewhere && (onTarget === null || elsewhere > onTarget)
        ? elsewhere
        : onTarget;
    const matchingFirstSeen =
      seller && row.fingerprint
        ? (newestMatchingFirstSeen.get(
            JSON.stringify([seller, row.fingerprint]),
          ) ?? 0)
        : 0;
    // A later indistinguishable listing prevents a confident exit even when
    // there are too many matches to link a specific possible relist.
    const ambiguousRelist =
      matchingFirstSeen > row.lastSeenAt.getTime() &&
      matchingFirstSeen >= row.goneAt.getTime() - captureRelistWindowMs;
    const kind = classifyExit(
      row,
      eventsByItem.get(row.itemId) ?? [],
      input.completeCaptureFloors?.get(row.lastCaptureId) ?? null,
      { otherLastSeenAt, ambiguousRelist },
    );
    const inLastDay = row.goneAt.getTime() >= since24;
    if (kind === 'uncertain') {
      uncertainExits72h += 1;
      if (inLastDay) uncertainExits24h += 1;
    }
    if (kind !== 'inferred') continue;
    exitAsks.push(new Decimal(row.priceChaos!));
    if (inLastDay) {
      inferredExits24h += 1;
      if (seller) inferredExitSellers24h.add(seller);
    }
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
    repriced24h: new Set(
      events
        .filter(
          (row) => row.type === 'price_changed' && row.at.getTime() >= since24,
        )
        .map((row) => row.itemId),
    ).size,
    relisted24h: new Set(
      events
        .filter(
          (row) =>
            row.type === 'possible_relist' &&
            row.at.getTime() >= since24 &&
            row.relatedItemId,
        )
        .map((row) => JSON.stringify([row.itemId, row.relatedItemId].sort())),
    ).size,
    inferredExits24h,
    inferredExitSellers24h: inferredExitSellers24h.size,
    uncertainExits24h,
    inferredExits72h: exitAsks.length,
    uncertainExits72h,
    recentExitAskChaos,
  };
}
