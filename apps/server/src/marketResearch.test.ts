import { describe, expect, it } from 'vitest';

import {
  createImportedMarketSnapshot,
  createMarketTarget,
} from './marketResearch.js';

const now = new Date('2026-10-29T12:00:00.000Z');
const profile = {
  name: 'Life and resistance belt',
  game: 'poe1',
  realm: 'pc',
  league: 'Standard',
  patch: '3.29',
  slot: 'Belt',
  baseTypes: ['Stygian Vise'],
  builds: ['Example build'],
  requiredMods: ['90+ maximum life'],
  minItemLevel: 84,
  qualityMin: 0,
  influences: [],
  corrupted: false,
  sources: [
    { title: 'Curated guide', url: 'https://example.com/guide', kind: 'guide' },
  ],
};

function observation(targetId: string) {
  return {
    targetId,
    capturedAt: '2026-10-28T12:00:00.000Z',
    sourceUrl: 'https://example.com/market-observation',
    currency: 'divine',
    dataKind: 'observed',
    listings: [
      {
        externalId: 'one',
        price: 2,
        item: {
          league: 'Standard',
          baseType: 'Stygian Vise',
          explicitMods: [
            { description: '+90 to maximum Life', flags: { crafted: true } },
          ],
        },
      },
      {
        externalId: 'two',
        price: 4,
        item: {
          league: 'Standard',
          baseType: 'Stygian Vise',
          explicitMods: ['+95 to maximum Life'],
        },
      },
      {
        externalId: 'three',
        price: 8,
        item: { league: 'Standard', baseType: 'Stygian Vise' },
      },
    ],
  };
}

describe('user-curated market evidence', () => {
  it('preserves source data and separates captured time from import time', () => {
    const target = createMarketTarget(profile, now);
    const input = observation(target.id);
    const snapshot = createImportedMarketSnapshot(input, target, now);
    expect(snapshot).toMatchObject({
      game: 'poe1',
      league: 'Standard',
      patch: '3.29',
      targetVersion: 1,
      targetDigest: target.digest,
      capturedAt: input.capturedAt,
      retrievedAt: now.toISOString(),
      provenance: 'manual_import',
      comparability: 'user_selected',
      dataKind: 'observed',
      count: 3,
      rejectedCount: 0,
      p25: 3,
      median: 4,
      p75: 6,
      listings: input.listings,
    });
    expect(snapshot).not.toHaveProperty('profit');
    expect(snapshot).not.toHaveProperty('sales');
  });

  it('deduplicates equivalent JSON and listing order without replacing capture time', () => {
    const target = createMarketTarget(profile, now);
    const input = observation(target.id);
    const initial = createImportedMarketSnapshot(input, target, now);
    const reordered = {
      ...input,
      listings: [...input.listings]
        .reverse()
        .map(({ item, price, externalId }) => ({
          item: Object.fromEntries(Object.entries(item).reverse()),
          price,
          externalId,
        })),
    };
    expect(
      createImportedMarketSnapshot(
        reordered,
        target,
        new Date('2026-10-30T00:00:00Z'),
      ).digest,
    ).toBe(initial.digest);
    expect(
      createMarketTarget(
        Object.fromEntries(Object.entries(profile).reverse()),
        now,
      ).digest,
    ).toBe(target.digest);
  });

  it('keeps league, currency and demo evidence distinct and rejects cross-league payloads', () => {
    const standard = createMarketTarget(profile, now);
    const otherLeague = createMarketTarget(
      { ...profile, league: 'Example League' },
      now,
    );
    const input = observation(standard.id);
    const first = createImportedMarketSnapshot(input, standard, now);
    const demo = createImportedMarketSnapshot(
      { ...input, dataKind: 'demo' },
      standard,
      now,
    );
    const chaos = createImportedMarketSnapshot(
      { ...input, currency: 'chaos' },
      standard,
      now,
    );
    expect(new Set([first.digest, demo.digest, chaos.digest]).size).toBe(3);
    expect(() =>
      createImportedMarketSnapshot(
        { ...input, targetId: otherLeague.id },
        otherLeague,
        now,
      ),
    ).toThrow();
    const second = createImportedMarketSnapshot(
      {
        ...input,
        targetId: otherLeague.id,
        listings: input.listings.map((row) => ({
          ...row,
          item: { ...row.item, league: 'Example League' },
        })),
      },
      otherLeague,
      now,
    );
    expect(second.league).toBe('Example League');
    expect(second.digest).not.toBe(first.digest);
    expect(() =>
      createImportedMarketSnapshot(input, otherLeague, now),
    ).toThrow();
  });

  it('requires an intentional empty observation and never turns it into zero price', () => {
    const target = createMarketTarget(profile, now);
    const empty = { ...observation(target.id), listings: [] };
    expect(() => createImportedMarketSnapshot(empty, target, now)).toThrow();
    expect(
      createImportedMarketSnapshot(
        { ...empty, emptyResult: true },
        target,
        now,
      ),
    ).toMatchObject({
      count: 0,
      outcome: 'no_listings',
      p25: null,
      median: null,
      p75: null,
    });
    expect(() =>
      createImportedMarketSnapshot(
        { ...observation(target.id), emptyResult: true },
        target,
        now,
      ),
    ).toThrow();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid price %s without a partial import',
    (price) => {
      const target = createMarketTarget(profile, now);
      const input = observation(target.id);
      expect(() =>
        createImportedMarketSnapshot(
          { ...input, listings: [{ price, item: {} }] },
          target,
          now,
        ),
      ).toThrow();
    },
  );

  it('rejects future timestamps, oversized imports and repeated listing identities', () => {
    const target = createMarketTarget(profile, now);
    const input = observation(target.id);
    expect(() =>
      createImportedMarketSnapshot(
        { ...input, capturedAt: '2026-10-29T12:05:01.000Z' },
        target,
        now,
      ),
    ).toThrow();
    expect(() =>
      createImportedMarketSnapshot(
        {
          ...input,
          listings: Array.from({ length: 1001 }, () => ({
            price: 1,
            item: {},
          })),
        },
        target,
        now,
      ),
    ).toThrow();
    expect(() =>
      createImportedMarketSnapshot(
        { ...input, listings: [input.listings[0], input.listings[0]] },
        target,
        now,
      ),
    ).toThrow();
    expect(() =>
      createImportedMarketSnapshot(
        { ...input, listings: [{ price: 1, currency: 'chaos', item: {} }] },
        target,
        now,
      ),
    ).toThrow();
  });
});
