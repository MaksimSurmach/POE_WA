import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { GameDataSource } from '@poe-worksmith/domain';

import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import { createGameDataRepository } from './gameData.js';

const pool = createDatabasePool(loadDatabaseConfig());
const repository = createGameDataRepository(pool);
const fixture: GameDataSource = {
  source: 'fixture-json',
  sourceRevision: 'abc123',
  patchVersion: '3.27.0',
  records: [
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
        stats: [],
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

afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query('truncate table game_data_versions cascade');
});

describe('PostgreSQL game-data catalog', () => {
  it('keeps an importing version invisible until atomically activated', async () => {
    const versionId = await repository.import(fixture);
    expect(await repository.openActive()).toBeNull();
    await repository.activate(versionId);
    const catalog = await repository.openActive();
    expect(catalog?.version()).toBe('3.27.0');
    await expect(catalog?.getMod('mod:physical')).resolves.toMatchObject({
      familyId: 'family:physical',
    });
  });
  it('preserves the active catalog when an invalid import fails', async () => {
    const versionId = await repository.import(fixture);
    await repository.activate(versionId);
    await expect(
      repository.import({
        ...fixture,
        records: [...fixture.records, fixture.records[0]!],
      }),
    ).rejects.toThrow('GAME_DATA_DUPLICATE_ID');
    expect((await repository.openActive())?.version()).toBe('3.27.0');
  });
});
