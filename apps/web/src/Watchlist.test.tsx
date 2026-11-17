import { expect, it } from 'vitest';
import { readFavorites } from './Watchlist.js';
it('validates browser favorites and preserves stable IDs without inventing targets', () => {
  expect(
    readFavorites('["stale-boots","stale-boots",null,2,"", "no-listings-bow"]'),
  ).toEqual(['stale-boots', 'no-listings-bow']);
  expect(readFavorites('{"recipe":"demo"}')).toEqual([]);
  expect(readFavorites('broken')).toEqual([]);
});
