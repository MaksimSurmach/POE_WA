import { describe, expect, it } from 'vitest';
import { analyzeBeltSnapshot } from './beltComparability.js';
import {
  createImportedMarketSnapshot,
  createMarketTarget,
} from './marketResearch.js';

const now = new Date('2026-10-29T12:00:00.000Z');
const target = createMarketTarget(
  {
    name: 'Fixture belt',
    game: 'poe1',
    realm: 'pc',
    league: 'Fixture',
    patch: 'test',
    slot: 'belt',
    baseTypes: ['Stygian Vise'],
    builds: [],
    requiredMods: [],
    sources: [],
    beltRules: {
      version: 1,
      minItemLevel: 84,
      influences: [],
      corrupted: false,
      mods: [{ id: 'life', minValue: 80, maxTier: 2 }],
    },
  },
  now,
);
const item = {
  baseType: 'Stygian Vise',
  rarity: 'rare',
  league: 'Fixture',
  patch: 'test',
  currency: 'chaos',
  itemLevel: 84,
  corrupted: false,
  influences: [],
  seller: 'Alice',
  status: 'listed',
  mods: [{ id: 'life', value: 90, tier: 2 }],
};
function snapshot(items: object[]) {
  return createImportedMarketSnapshot(
    {
      targetId: target.id,
      capturedAt: now.toISOString(),
      sourceUrl: 'https://example.com/fixture',
      currency: 'chaos',
      dataKind: 'demo',
      listings: items.map((entry, index) => ({
        externalId: String(index),
        price: 10 + index,
        item: entry,
      })),
    },
    target,
    now,
  );
}

describe('belt comparability v1', () => {
  it('rejects hard mismatches and marks unknown tier partial without mutating raw evidence', () => {
    const snap = snapshot([
      item,
      { ...item, mods: [{ id: 'life', value: 90 }] },
      { ...item, mods: [{ id: 'life', value: 79, tier: 2 }] },
      { ...item, baseType: 'Leather Belt' },
      { ...item, currency: 'divine' },
      { ...item, status: 'delisted' },
    ]);
    const original = JSON.stringify(snap);
    const result = analyzeBeltSnapshot(target, snap, now.getTime());
    expect(result.rows.map((row) => row.status)).toEqual([
      'MATCH',
      'PARTIAL',
      'REJECT',
      'REJECT',
      'REJECT',
      'REJECT',
    ]);
    expect(result.rows[1]?.reasons).toContain('life: tier unknown');
    expect(JSON.stringify(snap)).toBe(original);
  });
  it('deduplicates sellers, requires a fresh sample and never claims profit', () => {
    const snap = snapshot([
      item,
      { ...item, seller: 'alice' },
      ...['Bob', 'C', 'D', 'E'].map((seller) => ({ ...item, seller })),
    ]);
    const result = analyzeBeltSnapshot(target, snap, now.getTime());
    expect(result.independentSellers).toBe(5);
    expect(result.conservativeAskingPrice).toBe(12);
    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(
      analyzeBeltSnapshot(target, snap, now.getTime() + 86_400_001)
        .conservativeAskingPrice,
    ).toBeNull();
    expect(
      analyzeBeltSnapshot(target, snapshot([item]), now.getTime())
        .conservativeAskingPrice,
    ).toBeNull();
  });
  it('does not infer a match from legacy free-text rules or missing evidence', () => {
    const legacy = { ...target };
    delete legacy.beltRules;
    expect(
      analyzeBeltSnapshot(legacy, snapshot([{}]), now.getTime()).rows[0]
        ?.status,
    ).toBe('PARTIAL');
  });
});
