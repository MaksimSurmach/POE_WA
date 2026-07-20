import { describe, expect, it } from 'vitest';
import type { CanonicalCraftSetup } from './canonical/setup.js';
import {
  clusterJewelVariantFilter,
  mappedTargetFilter,
  noVariantFilter,
  RegisteredTradeQueryGenerator,
  type TradeMappingCatalog,
} from './trade.js';

const setup: CanonicalCraftSetup = {
  base: {
    baseId: 'base:large-cluster',
    influences: [],
    itemLevel: 84,
    rarity: 'rare',
    state: { corrupted: false, fractured: false, synthesised: false },
    variant: {
      kind: 'cluster-jewel',
      passiveCount: 8,
      smallPassiveStatId: 'stat:physical',
    },
  },
  gameDataVersion: '3.26.0',
  method: { kind: 'harvest-reforge', tag: 'physical' },
  startingMods: [],
  target: {
    allOf: [
      {
        excluded: false,
        kind: 'explicit',
        modId: 'mod:physical',
        minimumValue: 3,
      },
    ],
    anyOf: [
      { excluded: false, kind: 'explicit', modId: 'mod:chaos' },
      { excluded: false, kind: 'explicit', modId: 'mod:fire' },
    ],
    minimumMatched: 1,
  },
};
const mappings: TradeMappingCatalog = {
  resolveBase: async () => ({
    diagnostics: [],
    ok: true,
    value: {
      id: 'Large Cluster Jewel',
      mappingVersion: 'fixture-v1',
      discriminator: 'jewel',
      filters: {
        'enchant.stat_3086156145': 8,
        'enchant.stat_3948993189': 12,
        'enchant.stat_4079888060': 2,
      },
    },
  }),
  resolveTarget: async ({ target }) => ({
    diagnostics: [],
    ok: true,
    value:
      target.modId === 'mod:physical'
        ? { id: `explicit.${target.modId}`, minimum: 3 }
        : { id: `explicit.${target.modId}` },
  }),
};
const generator = new RegisteredTradeQueryGenerator(
  mappings,
  [noVariantFilter, clusterJewelVariantFilter],
  [mappedTargetFilter],
);

describe('Trade query generation', () => {
  it('generates a deterministic physical large-cluster query', async () => {
    const first = await generator.generate({ league: 'Mercenaries', setup });
    const second = await generator.generate({ league: 'Mercenaries', setup });
    expect(first).toMatchObject({
      ok: true,
      value: {
        diagnostics: { mappingVersion: 'fixture-v1' },
        hash: expect.any(String),
        query: {
          sort: { price: 'asc' },
          query: {
            filters: {
              misc_filters: {
                filters: { ilvl: { min: 84 }, 'enchant.stat_3086156145': 8 },
              },
            },
            stats: [{ type: 'and' }, { type: 'count', value: { min: 1 } }],
          },
        },
      },
    });
    expect(first.ok && second.ok && first.value.hash).toBe(
      second.ok && second.value.hash,
    );
  });
  it('returns a stable diagnostic instead of a broad query when mapping is missing', async () => {
    const missing = new RegisteredTradeQueryGenerator(
      {
        ...mappings,
        resolveTarget: async () => ({
          diagnostics: [
            {
              code: 'TRADE_MAPPING_MISSING',
              message: 'missing',
              path: [],
              severity: 'error' as const,
            },
          ],
          ok: false,
        }),
      },
      [noVariantFilter, clusterJewelVariantFilter],
      [mappedTargetFilter],
    );
    const result = await missing.generate({ league: 'Mercenaries', setup });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('TRADE_MAPPING_MISSING');
  });
});
