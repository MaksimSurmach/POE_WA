import { describe, expect, it } from 'vitest';

import {
  applyCapture,
  type Capture,
  type CaptureListing,
  type Listing,
} from './captureReducer.js';

const day = 24 * 60 * 60 * 1000;
const start = new Date('2026-11-10T00:00:00Z').getTime();

function sighting(
  itemId: string,
  changes: Partial<CaptureListing> = {},
): CaptureListing {
  return {
    itemId,
    seller: 'seller#1234',
    fingerprint: 'fingerprint',
    price: { amount: '1', currency: 'divine' },
    priceChaos: '100',
    indexedAt: null,
    item: { mods: ['+14 to Strength'] },
    ...changes,
  };
}

function capture(
  dayOffset: number,
  listings: readonly CaptureListing[],
  complete = true,
): Capture {
  return {
    id: `capture-${dayOffset}`,
    scheduleId: 'schedule',
    capturedAt: new Date(start + dayOffset * day),
    complete,
    listings,
  };
}

function gone(...sightings: CaptureListing[]): Listing[] {
  const first = applyCapture([], capture(0, sightings));
  const missed = applyCapture(first.listings, capture(1, []));
  return applyCapture(missed.listings, capture(2, [])).listings;
}

describe('applyCapture', () => {
  it('records first sightings even in a partial capture', () => {
    const offer = sighting('item');
    const batch = capture(0, [offer], false);
    const { listings, events } = applyCapture([], batch);

    expect(listings).toEqual([
      {
        scheduleId: batch.scheduleId,
        itemId: offer.itemId,
        seller: offer.seller,
        fingerprint: offer.fingerprint,
        priceOriginal: '1',
        currency: 'divine',
        priceChaos: '100',
        indexedAt: null,
        item: offer.item,
        firstCaptureId: batch.id,
        lastCaptureId: batch.id,
        firstSeenAt: batch.capturedAt,
        lastSeenAt: batch.capturedAt,
        status: 'active',
        missedCompleteCaptures: 0,
        goneAt: null,
        firstMissingAt: null,
        unchangedAskSince: batch.capturedAt,
      },
    ]);
    expect(events).toEqual([
      {
        scheduleId: batch.scheduleId,
        itemId: offer.itemId,
        captureId: batch.id,
        at: batch.capturedAt,
        type: 'first_seen',
        fromPriceChaos: null,
        toPriceChaos: '100',
        relatedItemId: null,
      },
    ]);
  });

  it('updates FX and last-seen data without changing first-seen data or recording a reprice', () => {
    const offer = sighting('item');
    const first = capture(0, [offer]);
    const previous = applyCapture([], first).listings;
    const second = capture(1, [
      sighting('item', {
        price: { amount: '1.00000000', currency: 'divine' },
        priceChaos: '120',
        item: { mods: ['replacement payload'] },
      }),
    ]);
    const { listings, events } = applyCapture(previous, second);

    expect(events).toEqual([]);
    expect(listings[0]).toMatchObject({
      firstCaptureId: first.id,
      firstSeenAt: first.capturedAt,
      lastCaptureId: second.id,
      lastSeenAt: second.capturedAt,
      priceChaos: '120',
      item: offer.item,
    });
    expect(previous[0]).toMatchObject({
      lastCaptureId: first.id,
      priceChaos: '100',
    });
  });

  it.each([
    { amount: '1.01', currency: 'divine' },
    { amount: '1', currency: 'exalted' },
  ])(
    'records an original ask change to $amount $currency even at equal normalized values',
    (price) => {
      const previous = applyCapture(
        [],
        capture(0, [sighting('item')]),
      ).listings;
      const { listings, events } = applyCapture(
        previous,
        capture(1, [sighting('item', { price })]),
      );

      expect(listings[0]).toMatchObject({
        priceOriginal: price.amount,
        currency: price.currency,
      });
      expect(events).toMatchObject([
        {
          itemId: 'item',
          type: 'price_changed',
          fromPriceChaos: '100',
          toPriceChaos: '100',
        },
      ]);
    },
  );

  it('stores an unknown ask without asserting a price change', () => {
    const previous = applyCapture([], capture(0, [sighting('item')])).listings;
    const unpriced = applyCapture(
      previous,
      capture(1, [sighting('item', { price: null, priceChaos: null })]),
    );
    expect(unpriced.listings[0]).toMatchObject({
      priceOriginal: null,
      currency: null,
      priceChaos: null,
    });
    expect(unpriced.events).toEqual([]);
    expect(
      applyCapture(unpriced.listings, capture(2, [sighting('item')])).events,
    ).toEqual([]);
  });

  it('ignores partial absences, counts complete misses, and emits gone only once', () => {
    const previous = applyCapture([], capture(0, [sighting('item')])).listings;
    expect(applyCapture(previous, capture(1, [], false))).toEqual({
      listings: previous,
      events: [],
    });

    const missed = applyCapture(previous, capture(2, []));
    expect(missed.listings[0]).toMatchObject({
      lastSeenAt: capture(0, []).capturedAt,
      lastCaptureId: 'capture-0',
      status: 'missing',
      missedCompleteCaptures: 1,
      goneAt: null,
    });
    expect(missed.events).toMatchObject([{ itemId: 'item', type: 'missed' }]);
    expect(applyCapture(missed.listings, capture(3, [], false))).toEqual({
      listings: missed.listings,
      events: [],
    });

    const absent = applyCapture(missed.listings, capture(4, []));
    expect(absent.listings[0]).toMatchObject({
      status: 'gone',
      missedCompleteCaptures: 2,
      goneAt: capture(4, []).capturedAt,
    });
    expect(absent.events).toMatchObject([{ itemId: 'item', type: 'gone' }]);
    expect(applyCapture(absent.listings, capture(5, []))).toEqual({
      listings: absent.listings,
      events: [],
    });
  });

  it.each(['missing', 'gone'])(
    'reactivates a %s item on sight, even in a partial capture',
    (status) => {
      const offer = sighting('item');
      const previous =
        status === 'gone'
          ? gone(offer)
          : applyCapture(
              applyCapture([], capture(0, [offer])).listings,
              capture(1, []),
            ).listings;
      const seen = applyCapture(previous, capture(3, [offer], false));

      expect(seen.listings[0]).toMatchObject({
        firstCaptureId: 'capture-0',
        lastCaptureId: 'capture-3',
        status: 'active',
        missedCompleteCaptures: 0,
        goneAt: null,
      });
      expect(seen.events).toMatchObject([
        { itemId: 'item', type: 'reappeared' },
      ]);
      expect(applyCapture(seen.listings, capture(4, [])).events).toMatchObject([
        { type: 'missed' },
      ]);
    },
  );

  it('links a unique relist in both directions exactly seven days after gone', () => {
    const previous = gone(sighting('old'));
    const result = applyCapture(previous, capture(9, [sighting('new')], false));
    expect(result.events).toMatchObject([
      { itemId: 'new', type: 'first_seen' },
      { itemId: 'old', type: 'possible_relist', relatedItemId: 'new' },
      { itemId: 'new', type: 'possible_relist', relatedItemId: 'old' },
    ]);
    expect(
      result.listings.map(({ itemId, status }) => [itemId, status]),
    ).toEqual([
      ['old', 'gone'],
      ['new', 'active'],
    ]);
    expect(
      applyCapture(result.listings, capture(10, [sighting('new')])).events,
    ).toEqual([]);
  });

  it.each([
    ['expired', 10, [sighting('old')], [sighting('new')]],
    ['future', 1.5, [sighting('old')], [sighting('new')]],
    [
      'wrong seller',
      3,
      [sighting('old')],
      [sighting('new', { seller: 'different' })],
    ],
    [
      'wrong fingerprint',
      3,
      [sighting('old')],
      [sighting('new', { fingerprint: 'different' })],
    ],
    [
      'unknown seller',
      3,
      [sighting('old', { seller: null })],
      [sighting('new', { seller: null })],
    ],
    [
      'unknown fingerprint',
      3,
      [sighting('old', { fingerprint: null })],
      [sighting('new', { fingerprint: null })],
    ],
    [
      'multiple gone IDs',
      3,
      [sighting('old'), sighting('other-old')],
      [sighting('new')],
    ],
    [
      'multiple new IDs',
      3,
      [sighting('old')],
      [sighting('new'), sighting('other-new')],
    ],
  ] as const)(
    'suppresses relist evidence: %s',
    (_label, offset, old, current) => {
      const result = applyCapture(gone(...old), capture(offset, current));
      expect(result.events.map(({ type }) => type)).toEqual(
        current.map(() => 'first_seen'),
      );
    },
  );

  it('can link a replacement seen in the same capture that marks the old ID gone', () => {
    const first = applyCapture([], capture(0, [sighting('old')]));
    const missed = applyCapture(first.listings, capture(1, []));
    const result = applyCapture(missed.listings, capture(2, [sighting('new')]));

    expect(result.events).toMatchObject([
      { itemId: 'new', type: 'first_seen' },
      { itemId: 'old', type: 'gone' },
      { itemId: 'old', type: 'possible_relist', relatedItemId: 'new' },
      { itemId: 'new', type: 'possible_relist', relatedItemId: 'old' },
    ]);
  });

  it('suppresses a relist when another known ID with the same fingerprint is still active', () => {
    const active = sighting('still-active');
    const first = applyCapture([], capture(0, [sighting('old'), active]));
    const missed = applyCapture(first.listings, capture(1, [active]));
    const absent = applyCapture(missed.listings, capture(2, [active]));
    const result = applyCapture(
      absent.listings,
      capture(3, [active, sighting('new')]),
    );

    expect(result.events).toMatchObject([
      { itemId: 'new', type: 'first_seen' },
    ]);
  });

  it('links a replacement that first appeared during the first complete miss', () => {
    const replacement = sighting('new');
    const first = applyCapture([], capture(0, [sighting('old')]));
    const missed = applyCapture(first.listings, capture(1, [replacement]));
    expect(missed.events.map(({ type }) => type)).toEqual([
      'first_seen',
      'missed',
    ]);

    const absent = applyCapture(missed.listings, capture(2, [replacement]));
    expect(absent.events).toMatchObject([
      { itemId: 'old', type: 'gone' },
      { itemId: 'old', type: 'possible_relist', relatedItemId: 'new' },
      { itemId: 'new', type: 'possible_relist', relatedItemId: 'old' },
    ]);
    expect(
      applyCapture(absent.listings, capture(3, [replacement])).events,
    ).toEqual([]);
  });

  it('does not link a preexisting listing when the other ID becomes gone', () => {
    const existing = sighting('existing');
    const first = applyCapture([], capture(0, [sighting('old'), existing]));
    const missed = applyCapture(first.listings, capture(1, [existing]));
    const absent = applyCapture(missed.listings, capture(2, [existing]));

    expect(absent.events).toMatchObject([{ itemId: 'old', type: 'gone' }]);
  });

  it('does not link a replacement first seen more than seven days before gone', () => {
    const replacement = sighting('new');
    const first = applyCapture([], capture(0, [sighting('old')]));
    const missed = applyCapture(first.listings, capture(1, [replacement]));
    const absent = applyCapture(missed.listings, capture(9, [replacement]));

    expect(absent.events).toMatchObject([{ itemId: 'old', type: 'gone' }]);
  });

  it('does not pair with a gone ID that is also seen in the current capture', () => {
    const old = sighting('old');
    const result = applyCapture(gone(old), capture(3, [old, sighting('new')]));
    expect(result.events.map(({ type }) => type)).toEqual([
      'reappeared',
      'first_seen',
    ]);
  });
});
