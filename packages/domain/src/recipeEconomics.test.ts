import { describe, expect, it } from 'vitest';
import { gradeSaleEvidence } from './recipeEconomics.js';

describe('sale evidence grades', () => {
  const complete = {
    sellers: 5,
    coverage: 'complete' as const,
    sortedSampleComplete: false,
    oldestInputAgeMs: 60_000,
    freshnessWarningMs: 60_000,
    ignoredOutliers: 0,
  };

  it.each([
    ['five sellers with complete fresh evidence', {}, 'A', []],
    ['one seller with complete evidence', { sellers: 1 }, 'C', ['1 seller']],
    ['two sellers', { sellers: 2 }, 'B', ['2–4 sellers']],
    ['four sellers', { sellers: 4 }, 'B', ['2–4 sellers']],
    [
      'validated sorted sample',
      { coverage: 'partial', sortedSampleComplete: true },
      'B',
      ['sorted sample, not full coverage'],
    ],
    [
      'inputs past the warning age',
      { oldestInputAgeMs: 60_001 },
      'B',
      ['inputs older than warning age'],
    ],
    ['ignored outlier', { ignoredOutliers: 1 }, 'B', ['outlier ask ignored']],
    [
      'single seller with a warning-age input',
      { sellers: 1, oldestInputAgeMs: 60_001 },
      'C',
      ['1 seller', 'inputs older than warning age'],
    ],
  ] as const)('grades %s', (_label, input, grade, reasons) => {
    expect(gradeSaleEvidence({ ...complete, ...input })).toEqual({
      grade,
      reasons,
    });
  });
});
