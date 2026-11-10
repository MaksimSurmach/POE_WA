import { describe, expect, it } from 'vitest';

import {
  classifyExit,
  summarizeMarketActivity,
  type ActivityEvent,
  type ActivityListing,
} from './marketActivity.js';

const hour = 60 * 60 * 1000;
const now = new Date('2026-11-10T12:00:00Z');
const ago = (hours: number) => new Date(now.getTime() - hours * hour);

function listing(
  itemId: string,
  changes: Partial<ActivityListing> = {},
): ActivityListing {
  return {
    itemId,
    seller: 'seller',
    priceChaos: '100',
    firstSeenAt: ago(40),
    lastSeenAt: ago(0),
    lastCaptureId: 'latest',
    status: 'active',
    goneAt: null,
    ...changes,
  };
}

/** Last seen 10 h ago, missed 8 h ago, gone 6 h ago. */
function gone(itemId: string, changes: Partial<ActivityListing> = {}) {
  return listing(itemId, {
    lastSeenAt: ago(10),
    lastCaptureId: 'earlier',
    status: 'gone',
    goneAt: ago(6),
    ...changes,
  });
}

function event(
  itemId: string,
  type: ActivityEvent['type'],
  hoursAgo: number,
): ActivityEvent {
  return { itemId, type, at: ago(hoursAgo) };
}

const missed = [event('item', 'missed', 8)];
const seen = { otherLastSeenAt: ago(0) };

describe('classifyExit', () => {
  it('infers an exit near the floor after two separated misses', () => {
    expect(classifyExit(gone('item'), missed, '90', seen)).toBe('inferred');
  });

  it('does not treat a listed or relisted item as an exit', () => {
    expect(classifyExit(listing('item'), [], '90', seen)).toBeNull();
    expect(
      classifyExit(
        gone('item'),
        [...missed, event('item', 'possible_relist', 6)],
        '90',
        seen,
      ),
    ).toBeNull();
  });

  it.each([
    [
      'misses under 2 h apart',
      gone('item'),
      [event('item', 'missed', 7)],
      '90',
      seen,
    ],
    ['no recorded first miss', gone('item'), [], '90', seen],
    ['unknown floor at last sight', gone('item'), missed, null, seen],
    [
      'unknown last price',
      gone('item', { priceChaos: null }),
      missed,
      '90',
      seen,
    ],
    ['price over 20% above the floor', gone('item'), missed, '80', seen],
    [
      'seller not seen elsewhere',
      gone('item'),
      missed,
      '90',
      { otherLastSeenAt: null },
    ],
    [
      'seller last seen before the miss',
      gone('item'),
      missed,
      '90',
      { otherLastSeenAt: ago(10) },
    ],
  ] as const)('is uncertain with %s', (_, row, events, floor, seller) => {
    expect(classifyExit(row, events, floor, seller)).toBe('uncertain');
  });
});

describe('summarizeMarketActivity', () => {
  const exits = ['a', 'b', 'c'].map((id, index) =>
    gone(id, { priceChaos: String(100 + index * 10) }),
  );
  const events = [
    ...exits.map(({ itemId }) => event(itemId, 'missed', 8)),
    event('still', 'price_changed', 5),
  ];
  const listings = [
    ...exits,
    listing('still', { priceChaos: '300' }),
    listing('other', { seller: 'other', priceChaos: '150' }),
  ];

  it('counts exits against the floor at last sight and keeps the median ask', () => {
    expect(
      summarizeMarketActivity({
        listings,
        events,
        latestCompleteCaptureId: 'latest',
        completeCaptureFloors: new Map([['earlier', '100']]),
        now,
      }),
    ).toEqual({
      active: 2,
      distinctSellers: 2,
      repriced72h: 1,
      repriced24h: 1,
      relisted24h: 0,
      inferredExits24h: 3,
      inferredExitSellers24h: 1,
      uncertainExits24h: 0,
      inferredExits72h: 3,
      uncertainExits72h: 0,
      recentExitAskChaos: '110',
    });
  });

  it('withholds supply without complete coverage and the ask below three exits', () => {
    expect(
      summarizeMarketActivity({
        listings: listings.slice(1),
        events,
        latestCompleteCaptureId: null,
        completeCaptureFloors: new Map([['earlier', '100']]),
        now,
      }),
    ).toMatchObject({
      active: null,
      distinctSellers: null,
      inferredExits72h: 2,
      recentExitAskChaos: null,
    });
  });

  it('marks a whole seller withdrawal uncertain and ignores exits outside 72 h', () => {
    const withdrawn = ['a', 'b'].map((id) => gone(id));
    const old = gone('old', {
      seller: 'other',
      lastSeenAt: ago(90),
      goneAt: ago(80),
    });
    expect(
      summarizeMarketActivity({
        listings: [...withdrawn, old, listing('live', { seller: 'other' })],
        events: [
          ...withdrawn.map(({ itemId }) => event(itemId, 'missed', 8)),
          event('old', 'missed', 85),
        ],
        latestCompleteCaptureId: 'latest',
        completeCaptureFloors: new Map([['earlier', '100']]),
        now,
      }),
    ).toMatchObject({
      inferredExits72h: 0,
      uncertainExits72h: 2,
      recentExitAskChaos: null,
    });
  });
});

it('keeps an exit uncertain when several newer same-seller items could be a relist', () => {
  const fingerprint = 'matching-mods';
  const activity = summarizeMarketActivity({
    listings: [
      gone('item', { fingerprint }),
      listing('replacement-one', { fingerprint, firstSeenAt: ago(7) }),
      listing('replacement-two', { fingerprint, firstSeenAt: ago(5) }),
    ],
    events: missed,
    latestCompleteCaptureId: 'latest',
    completeCaptureFloors: new Map([['earlier', '100']]),
    now,
  });
  expect(activity).toMatchObject({ inferredExits24h: 0, uncertainExits24h: 1 });
});
