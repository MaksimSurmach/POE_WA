import { marketTradeQueryResponseSchema } from '@poe-worksmith/contracts';
import { describe, expect, it } from 'vitest';
import { createMarketTarget } from './marketResearch.js';
import { generateMarketTradeQuery } from './marketTradeQuery.js';
import { tradeStatMappings } from './tradeStatMappings.js';

const input = {
  name: 'Equivalent finished boots',
  game: 'poe1',
  realm: 'pc',
  league: 'Fixture',
  patch: 'test',
  slot: 'crafted-item',
  baseTypes: ['Slink Boots'],
  builds: [],
  requiredMods: [],
  sources: [],
  minItemLevel: 84,
  corrupted: false,
  tradeSearch: {
    version: 1,
    scope: 'strict',
    status: 'securable',
    currency: 'chaos',
    rarity: 'rare',
    groups: [],
  },
};
describe('category-scoped Trade search', () => {
  it.each(['armour.boots', 'armour.gloves', 'accessory.ring', 'armour.helmet'])(
    'uses the supported %s category without pinning a base',
    (category) => {
      const target = createMarketTarget({
        ...input,
        tradeSearch: { ...input.tradeSearch, category },
      });
      const { request } = generateMarketTradeQuery(target);
      expect(request.query).not.toHaveProperty('type');
      expect(request.query.filters.type_filters.filters).toEqual({
        rarity: { option: 'rare' },
        category: { option: category },
      });
      expect(request.query.filters.misc_filters.filters).toMatchObject({
        ilvl: { min: 84 },
        corrupted: { option: 'false' },
      });
    },
  );
  it('opens the full search when many filters produce a long URL', () => {
    const filters = Object.keys(tradeStatMappings)
      .slice(0, 20)
      .map((id) => ({ id, min: 1 }));
    const target = createMarketTarget({
      ...input,
      league: 'Fixture League',
      tradeSearch: { ...input.tradeSearch, groups: [{ type: 'and', filters }] },
    });
    const data = generateMarketTradeQuery(target);
    const url = new URL(data.url);
    expect(url.pathname).toBe('/trade/search/Fixture%20League');
    expect(JSON.parse(url.searchParams.get('q')!)).toEqual(data.request);
    expect(data.url.length).toBeGreaterThan(2048);
    expect(
      marketTradeQueryResponseSchema.safeParse({
        correlationId: crypto.randomUUID(),
        data,
      }).success,
    ).toBe(true);
  });
  it('retains an exact base when there is no category policy', () => {
    expect(
      generateMarketTradeQuery(createMarketTarget(input)).request.query,
    ).toMatchObject({ type: 'Slink Boots' });
  });
  it('rejects unsupported category policies before generating a query', () => {
    expect(() =>
      createMarketTarget({
        ...input,
        tradeSearch: { ...input.tradeSearch, category: 'armour.belt' },
      }),
    ).toThrow(/target profile is invalid/);
  });
});
