import { describe, expect, it } from 'vitest';
import { marketDemo } from './marketDemo.js';
import {
  filterTargets,
  marketStatus,
  snapshotsForTarget,
} from './marketWorkbench.js';

describe('market evidence selection', () => {
  const target = marketDemo.targets[0]!;
  const snapshot = marketDemo.snapshots[0]!;

  it('isolates target version, league, patch, currency and provenance before charting', () => {
    const candidates = [
      snapshot,
      { ...snapshot, id: 'other-league', league: 'Other League' },
      { ...snapshot, id: 'other-game-data', patch: 'other-patch' },
      { ...snapshot, id: 'other-profile', targetDigest: 'f'.repeat(64) },
      { ...snapshot, id: 'actual-evidence', dataKind: 'observed' as const },
      { ...snapshot, id: 'other-currency', currency: 'chaos' as const },
    ];
    expect(
      snapshotsForTarget(target, candidates, 'demo', 'divine').map(
        ({ id }) => id,
      ),
    ).toEqual([snapshot.id]);
  });

  it('keeps a genuine zero-result observation and does not turn it into a zero price', () => {
    const empty = {
      ...snapshot,
      dataKind: 'observed' as const,
      outcome: 'no_listings' as const,
      count: 0,
      median: null,
      p25: null,
      p75: null,
    };
    expect(
      snapshotsForTarget(target, [empty], 'observed')[0]?.median,
    ).toBeNull();
    expect(marketStatus(empty, Date.parse(empty.capturedAt)).label).toBe(
      'Нет предложений',
    );
  });

  it('labels stale evidence and small samples without claiming liquidity or profitability', () => {
    const observed = { ...snapshot, dataKind: 'observed' as const, count: 3 };
    expect(
      marketStatus(observed, Date.parse(observed.capturedAt) + 1000).label,
    ).toBe('Малая выборка');
    expect(
      marketStatus(observed, Date.parse(observed.capturedAt) + 25 * 3600_000)
        .label,
    ).toBe('Старше 24 часов');
    expect(marketStatus(null).label).toBe('Нет наблюдений');
  });

  it('filters candidate profiles by requirements and league', () => {
    expect(filterTargets(marketDemo.targets, 'Strength', 'all')).toHaveLength(
      1,
    );
    expect(
      filterTargets(marketDemo.targets, '', 'Unknown League'),
    ).toHaveLength(0);
  });
});
