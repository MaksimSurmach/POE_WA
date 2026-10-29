import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { analyzeBeltSnapshot } from '../beltComparability.js';
import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import {
  createImportedMarketSnapshot,
  createMarketTarget,
} from '../marketResearch.js';
import { createMarketResearchRepository } from './marketResearchRepository.js';

const config = loadDatabaseConfig();
const databaseUrl = new URL(config.connectionString);
if (
  config.environment !== 'test' ||
  databaseUrl.pathname !== '/poe_worksmith_test' ||
  !['localhost', '127.0.0.1', '[::1]', 'postgres-test'].includes(
    databaseUrl.hostname,
  )
) {
  throw new Error(
    'Market integration tests require the isolated local poe_worksmith_test database',
  );
}
const pool = createDatabasePool(config);
const repository = createMarketResearchRepository(pool);
const now = new Date('2026-10-29T12:00:00.000Z');

afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query('truncate market_research_snapshots, market_targets');
});

describe('persistent market research', () => {
  it('retains a synthetic belt and its versioned rules for later analysis', async () => {
    const target = await repository.saveTarget(
      createMarketTarget(
        {
          name: 'Fixture',
          game: 'poe1',
          realm: 'pc',
          league: 'Fixture',
          patch: 'fixture',
          slot: 'Belt',
          baseTypes: ['Stygian Vise'],
          builds: [],
          requiredMods: [],
          sources: [],
          beltRules: {
            version: 1,
            minItemLevel: 84,
            influences: [],
            corrupted: false,
            mods: [{ id: 'life', minValue: 80 }],
          },
        },
        now,
      ),
    );
    const item = {
      baseType: 'Stygian Vise',
      rarity: 'rare',
      league: 'Fixture',
      patch: 'fixture',
      currency: 'chaos',
      itemLevel: 84,
      corrupted: false,
      influences: [],
      seller: 'demo',
      status: 'listed',
      mods: [{ id: 'life', value: 90 }],
    };
    const snapshot = await repository.saveSnapshot(
      createImportedMarketSnapshot(
        {
          targetId: target.id,
          capturedAt: now.toISOString(),
          sourceUrl: 'https://example.com/demo',
          currency: 'chaos',
          dataKind: 'demo',
          listings: [{ price: 10, item }],
        },
        target,
        now,
      ),
    );
    const reloaded = createMarketResearchRepository(pool);
    const persistedTarget = await reloaded.findTarget(target.id);
    const persisted = await reloaded.findSnapshot(snapshot.id);
    expect(persistedTarget).not.toBeNull();
    expect(persisted).not.toBeNull();
    if (!persistedTarget || !persisted)
      throw new Error('Missing stored evidence');
    expect(persisted.listings[0]?.item).toEqual(item);
    expect(
      analyzeBeltSnapshot(persistedTarget, persisted, now.getTime()).rows[0]
        ?.status,
    ).toBe('MATCH');
  });

  it('preserves immutable evidence across repository instances and concurrent repeated imports', async () => {
    const input = {
      name: 'Crafting target',
      game: 'poe1',
      realm: 'pc',
      league: 'Standard',
      patch: '3.29',
      slot: 'Belt',
      baseTypes: ['Stygian Vise'],
      builds: ['Curated build'],
      requiredMods: ['90+ life'],
      sources: [],
    };
    const target = await repository.saveTarget(createMarketTarget(input, now));
    const repeatedTarget = await repository.saveTarget(
      createMarketTarget(input, now),
    );
    expect(repeatedTarget.id).toBe(target.id);
    const imported = {
      targetId: target.id,
      capturedAt: '2026-10-28T00:00:00.000Z',
      sourceUrl: 'https://example.com/evidence',
      currency: 'divine',
      dataKind: 'observed',
      listings: [
        {
          price: 3,
          item: {
            league: 'Standard',
            baseType: 'Stygian Vise',
            explicitMods: [
              {
                description: '+90 to maximum Life',
                flags: { fractured: true },
              },
            ],
          },
        },
      ],
    };
    const [first, second] = await Promise.all([
      repository.saveSnapshot(
        createImportedMarketSnapshot(imported, target, now),
      ),
      repository.saveSnapshot(
        createImportedMarketSnapshot(imported, target, now),
      ),
    ]);
    expect(first.id).toBe(second.id);
    expect(
      await createMarketResearchRepository(pool).findSnapshot(first.id),
    ).toEqual(first);
    expect(first.listings).toEqual(imported.listings);
    const demo = await repository.saveSnapshot(
      createImportedMarketSnapshot(
        { ...imported, dataKind: 'demo' },
        target,
        now,
      ),
    );
    expect(demo.id).not.toBe(first.id);
    expect(await repository.listSnapshots()).toHaveLength(2);
  });
});
