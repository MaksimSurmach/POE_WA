import { Decimal } from 'decimal.js';

import type { CanonicalJsonObject, ProviderMoney } from './marketProviders.js';

export type CaptureListing = Readonly<{
  itemId: string;
  seller: string | null;
  fingerprint: string | null;
  price: ProviderMoney | null;
  priceChaos: string | null;
  indexedAt: Date | null;
  item: CanonicalJsonObject;
}>;

export type Capture = Readonly<{
  id: string;
  scheduleId: string;
  capturedAt: Date;
  complete: boolean;
  listings: readonly CaptureListing[];
}>;

export type Listing = Readonly<
  Omit<CaptureListing, 'price'> & {
    scheduleId: string;
    priceOriginal: string | null;
    currency: string | null;
    firstSeenAt: Date;
    lastSeenAt: Date;
    firstCaptureId: string;
    lastCaptureId: string;
    status: 'active' | 'missing' | 'gone';
    missedCompleteCaptures: number;
    goneAt: Date | null;
  }
>;

export type ListingEvent = Readonly<{
  scheduleId: string;
  itemId: string;
  captureId: string;
  at: Date;
  type:
    | 'first_seen'
    | 'price_changed'
    | 'missed'
    | 'reappeared'
    | 'gone'
    | 'possible_relist';
  fromPriceChaos: string | null;
  toPriceChaos: string | null;
  relatedItemId: string | null;
}>;

export const captureRelistWindowMs = 7 * 24 * 60 * 60 * 1000;

/** Applies one capture to the previous listings for its schedule. */
export function applyCapture(
  previous: readonly Listing[],
  capture: Capture,
): { listings: Listing[]; events: ListingEvent[] } {
  const { capturedAt, scheduleId, id: captureId } = capture;
  const sightings = new Map(capture.listings.map((row) => [row.itemId, row]));
  const listings = new Map(previous.map((row) => [row.itemId, row]));
  const newIds = new Set<string>();
  const newlyGoneIds = new Set<string>();
  const events: ListingEvent[] = [];

  const emit = (
    itemId: string,
    type: ListingEvent['type'],
    fromPriceChaos: string | null = null,
    toPriceChaos: string | null = null,
    relatedItemId: string | null = null,
  ) =>
    events.push({
      scheduleId,
      itemId,
      captureId,
      at: capturedAt,
      type,
      fromPriceChaos,
      toPriceChaos,
      relatedItemId,
    });

  for (const { price, ...sighting } of sightings.values()) {
    const { itemId, priceChaos } = sighting;
    const before = listings.get(itemId);

    listings.set(itemId, {
      ...sighting,
      scheduleId,
      priceOriginal: price?.amount ?? null,
      currency: price?.currency ?? null,
      firstSeenAt: before?.firstSeenAt ?? capturedAt,
      lastSeenAt: capturedAt,
      firstCaptureId: before?.firstCaptureId ?? captureId,
      lastCaptureId: captureId,
      item: before?.item ?? sighting.item,
      status: 'active',
      missedCompleteCaptures: 0,
      goneAt: null,
    });

    if (!before) {
      newIds.add(itemId);
      emit(itemId, 'first_seen', null, priceChaos);
      continue;
    }
    if (before.status !== 'active')
      emit(itemId, 'reappeared', null, priceChaos);
    if (
      price &&
      before.priceOriginal !== null &&
      before.currency !== null &&
      (price.currency !== before.currency ||
        !new Decimal(price.amount).eq(before.priceOriginal))
    ) {
      emit(itemId, 'price_changed', before.priceChaos, priceChaos);
    }
  }

  if (capture.complete) {
    for (const before of previous) {
      if (sightings.has(before.itemId) || before.status === 'gone') continue;
      const misses = before.missedCompleteCaptures + 1;
      const gone = misses >= 2;
      listings.set(before.itemId, {
        ...before,
        status: gone ? 'gone' : 'missing',
        missedCompleteCaptures: misses,
        goneAt: gone ? capturedAt : null,
      });
      if (gone) newlyGoneIds.add(before.itemId);
      emit(before.itemId, gone ? 'gone' : 'missed', before.priceChaos);
    }
  }

  if (newIds.size || newlyGoneIds.size) {
    const groups = new Map<string, Listing[]>();
    for (const row of listings.values()) {
      if (!row.seller?.trim() || !row.fingerprint?.trim()) continue;
      if (row.status === 'gone') {
        if (row.goneAt === null) continue;
        const age = capturedAt.getTime() - row.goneAt.getTime();
        if (age < 0 || age > captureRelistWindowMs) continue;
      }
      const key = JSON.stringify([row.seller, row.fingerprint]);
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }

    for (const group of groups.values()) {
      // Any additional live, missing, or recently gone ID makes the match ambiguous.
      if (group.length !== 2) continue;
      const before = group.find((row) => row.status === 'gone');
      const next = group.find((row) => row.status === 'active');
      if (!before || !next) continue;
      const seenBeforeGone =
        newlyGoneIds.has(before.itemId) &&
        next.firstSeenAt > before.lastSeenAt &&
        capturedAt.getTime() - next.firstSeenAt.getTime() <=
          captureRelistWindowMs;
      if (!newIds.has(next.itemId) && !seenBeforeGone) continue;
      emit(before.itemId, 'possible_relist', null, null, next.itemId);
      emit(next.itemId, 'possible_relist', null, null, before.itemId);
    }
  }

  return { listings: [...listings.values()], events };
}
