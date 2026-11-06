import { describe, expect, it } from 'vitest';
import { summarizeTradeHistory } from './tradeDashboard.js';

const hour = 3_600_000;
const base = Date.parse('2026-10-25T00:00:00.000Z');
const capture = (
  offset: number,
  identities: string[] | null,
  coverage: 'complete' | 'partial' = 'complete',
) => ({
  id: String(offset),
  at: new Date(base + hour * offset).toISOString(),
  currency: 'divine' as const,
  ask: 2,
  captured: identities?.length ?? null,
  coverage,
  identities,
  sellers: identities?.map(() => 'same seller') ?? null,
});
const history = (captures: ReturnType<typeof capture>[]) => ({
  id: 'test',
  name: 'Stygian Vise',
  slot: 'crafted-item',
  intervalMinutes: 60,
  captures,
});

describe('Trade dashboard aggregation', () => {
  it('counts separate offers from one account and retracts a raw exit when an ID reappears', () => {
    const offered = Array.from({ length: 16 }, (_, index) => String(index));
    const present = offered.slice(4);
    const captures = [
      capture(0, []),
      capture(1, offered),
      capture(2, present),
      capture(3, present),
      capture(4, present),
      capture(5, [...present, '0']),
      capture(6, [...present, '0']),
    ];
    const { item, points } = summarizeTradeHistory(
      history(captures),
      base,
      base + 6 * hour,
      true,
    );
    expect(points[0]).toMatchObject({ firstSeen: 16, missing: 0 });
    expect(points[1]).toMatchObject({ firstSeen: 0, missing: 4, sustained: 3 });
    expect(points[4]).toMatchObject({ firstSeen: 0, sustained: null });
    expect(item).toMatchObject({
      firstSeen: 16,
      sellers: 1,
      topSellerListings: 13,
      settledHours: 4,
      exits: 3,
      exitsPerDay: 18,
    });
  });

  it('preserves gaps across capped, expired, and skipped captures', () => {
    const captures = [
      capture(0, ['old']),
      capture(1, [], 'partial'),
      capture(2, ['old']),
      capture(3, null),
      capture(4, ['old']),
      capture(6, []),
    ];
    const { item, points } = summarizeTradeHistory(
      history(captures),
      base,
      base + 6 * hour,
      true,
    );
    expect(
      points.every(
        (point) => point.firstSeen === null && point.missing === null,
      ),
    ).toBe(true);
    expect(item).toMatchObject({
      firstSeen: null,
      exitsPerDay: null,
      visible48h: null,
    });
  });
});
