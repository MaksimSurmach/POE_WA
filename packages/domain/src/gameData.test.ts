import { describe, expect, it } from 'vitest';
import {
  CatalogModPoolResolver,
  GameDataValidationError,
  InMemoryGameDataCatalog,
  manifestHash,
  type GameDataSource,
} from './gameData.js';

const fixture: GameDataSource = {
  source: 'fixture-json',
  sourceRevision: 'abc123',
  patchVersion: '3.27.0',
  records: [
    { kind: 'tag', payload: { id: 'jewel', name: 'Jewel' } },
    {
      kind: 'base',
      payload: {
        id: 'base:large-physical-cluster',
        name: 'Large Cluster Jewel',
        itemClass: 'Jewel',
        domain: 'item',
        tags: ['jewel'],
        metadata: {},
      },
    },
    {
      kind: 'modFamily',
      payload: {
        id: 'family:physical',
        name: 'Physical',
        modIds: ['mod:physical'],
      },
    },
    {
      kind: 'mod',
      payload: {
        id: 'mod:physical',
        familyId: 'family:physical',
        name: 'Physical',
        generationType: 'prefix',
        requiredLevel: 50,
        tags: ['jewel'],
        spawnWeights: [{ tag: 'jewel', weight: 100 }],
        stats: [{ id: 'physical_damage', minimum: 1, maximum: 2 }],
      },
    },
    {
      kind: 'fossil',
      payload: {
        id: 'fossil:jagged',
        name: 'Jagged',
        tagModifiers: [{ tag: 'physical', weight: 10 }],
      },
    },
    {
      kind: 'clusterPassive',
      payload: {
        statId: 'stat:physical',
        baseId: 'base:large-physical-cluster',
        tags: ['physical'],
      },
    },
  ],
};
describe('game-data catalog', () => {
  it('resolves the Physical Large Cluster fixture and exposes its version', async () => {
    const resolver = new CatalogModPoolResolver(
      new InMemoryGameDataCatalog('v1', fixture),
    );
    await expect(
      resolver.resolve({
        baseId: 'base:large-physical-cluster',
        itemLevel: 84,
        rarity: 'rare',
        influences: [],
        state: { corrupted: false, fractured: false, synthesised: false },
        variant: {
          kind: 'cluster-jewel',
          passiveCount: 8,
          smallPassiveStatId: 'stat:physical',
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { gameDataVersion: 'v1', mods: [{ id: 'mod:physical' }] },
    });
  });
  it('rejects duplicate records before a catalog exists', () =>
    expect(
      () =>
        new InMemoryGameDataCatalog('v1', {
          ...fixture,
          records: [...fixture.records, fixture.records[0]!],
        }),
    ).toThrow(GameDataValidationError));
  it('hashes the complete pinned manifest', () =>
    expect(manifestHash(fixture)).toHaveLength(8));
});
