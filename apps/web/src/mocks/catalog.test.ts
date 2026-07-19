import { describe, expect, it } from 'vitest';

import { catalogFixtures, rawMarketSnapshots } from './catalog.js';

describe('mock catalog contracts', () => {
  it('runtime-validates raw snapshots and every UI state', () => {
    expect(rawMarketSnapshots).toHaveLength(4);
    expect(
      new Set(catalogFixtures.map(({ evaluation }) => evaluation.status)),
    ).toEqual(new Set(['success', 'stale', 'loading', 'partial', 'error']));
  });
});
