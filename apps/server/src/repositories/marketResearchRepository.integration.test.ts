import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { marketStarterLibrary } from '../marketStarterLibrary.js';
import { beltDemoFixture } from '../beltDemoFixture.js';

import { analyzeBeltSnapshot } from '../beltComparability.js';
import { evaluateBeltOpportunity } from '../beltOpportunity.js';
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
  await pool.query(
    'truncate market_collection_runs, market_collection_settings, belt_price_updates, market_research_snapshots, market_targets',
  );
});

describe('persistent market research', () => {
  it('routes a manual import through the collection record, matcher and ranking', async () => {
    const fixture = beltDemoFixture(now);
    const sourceUrl = 'https://example.com/manual-observation-fixture';
    const price = (
      evidence: NonNullable<typeof fixture.target.beltCraftMethod>['basePrice'],
    ) => ({
      ...evidence,
      dataKind: 'observed' as const,
      capturedAt: now.toISOString(),
      url: sourceUrl,
      notes: 'Integration fixture only.',
    });
    const method = fixture.target.beltCraftMethod;
    if (!method) throw new Error('invalid fixture');
    const target = await repository.saveTarget(
      createMarketTarget(
        {
          ...fixture.target,
          beltCraftMethod: {
            ...method,
            basePrice: price(method.basePrice),
            materials: method.materials.map((material) => ({
              ...material,
              price: price(material.price),
            })),
          },
        },
        now,
      ),
    );
    const imported = await repository.saveSnapshot(
      createImportedMarketSnapshot(
        {
          ...fixture.observation(target.id),
          sourceUrl,
          dataKind: 'observed',
          notes: 'Integration fixture only; verifies the manual import path.',
        },
        target,
        now,
      ),
    );
    const stored = await createMarketResearchRepository(pool).findSnapshot(
      imported.id,
    );
    if (!stored) throw new Error('Missing imported snapshot');
    const run = await pool.query<{ payload: { sourceId: string } }>(
      'select payload from market_collection_runs where id = $1',
      [imported.id],
    );
    const ranked = await evaluateBeltOpportunity(
      target,
      stored,
      undefined,
      now.getTime(),
    );
    expect(run.rows[0]?.payload.sourceId).toBe('manual-import');
    expect(
      analyzeBeltSnapshot(target, stored, now.getTime()).confirmedListings,
    ).toBe(5);
    expect(ranked).toMatchObject({
      snapshotId: imported.id,
      status: 'CALCULATED',
      economicConclusion: 'POSITIVE',
    });
  });

  it('preserves the manually observed Trade rows and refuses an unverified match after repository restart', async () => {
    const definition = marketStarterLibrary.find((item) =>
      item.name.startsWith('Winter Orb Elementalist — Stygian'),
    );
    if (!definition) throw new Error('Missing sourced target');
    const target = await repository.saveTarget(
      createMarketTarget(definition, now),
    );
    const content: unknown = JSON.parse(
      await readFile(
        '../../docs/evidence/max-1287-winter-orb-trade-2026-10-29.json',
        'utf8',
      ),
    );
    if (!content || typeof content !== 'object' || Array.isArray(content))
      throw new Error('Invalid observation');
    const saved = await repository.saveSnapshot(
      createImportedMarketSnapshot(
        { ...content, targetId: target.id },
        target,
        new Date('2026-10-29T21:00:00Z'),
      ),
    );
    const restored = await createMarketResearchRepository(pool).findSnapshot(
      saved.id,
    );
    expect(restored).toEqual(saved);
    if (!restored) throw new Error('Missing saved observation');
    expect(restored.dataKind).toBe('observed');
    const collection = await pool.query<{ payload: unknown }>(
      'select payload from market_collection_runs where id = $1',
      [saved.id],
    );
    expect(collection.rows[0]?.payload).toMatchObject({
      id: saved.id,
      snapshotId: saved.id,
      sourceId: 'manual-import',
      sourceUrl: saved.sourceUrl,
      status: 'partial',
      coverage: 'partial',
      queryDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      listings: saved.listings.map((listing) => ({
        ...listing,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      })),
    });
    expect(
      analyzeBeltSnapshot(
        target,
        restored,
        Date.parse(restored.capturedAt),
      ).rows.map((row) => row.status),
    ).toEqual(['PARTIAL', 'PARTIAL', 'PARTIAL', 'PARTIAL', 'PARTIAL']);
    const ranked = await evaluateBeltOpportunity(
      target,
      restored,
      undefined,
      Date.parse(restored.capturedAt),
    );
    expect(ranked).toMatchObject({
      snapshotId: saved.id,
      comparison: {
        snapshotId: saved.id,
        confirmedListings: 0,
      },
    });
  });

  it('persists distinct price observations without mutating the target', async () => {
    const fixture = beltDemoFixture(now);
    const target = await repository.saveTarget(
      createMarketTarget(fixture.target, now),
    );
    const method = target.beltCraftMethod;
    if (!method || method.basePrice.source !== 'manual' || !method.materials[0])
      throw new Error('invalid demo');
    const first = {
      id: randomUUID(),
      targetId: target.id,
      targetDigest: target.digest,
      digest: 'a'.repeat(64),
      createdAt: now.toISOString(),
      dataKind: 'demo' as const,
      basePrice: method.basePrice,
      materialPrices: { [method.materials[0].id]: method.materials[0].price },
    };
    const second = {
      ...first,
      id: randomUUID(),
      digest: 'b'.repeat(64),
      createdAt: new Date(now.getTime() + 1000).toISOString(),
      basePrice: { ...method.basePrice, amount: 22 },
    };
    if (!repository.savePriceUpdate) throw new Error('Repository lacks prices');
    await repository.savePriceUpdate(first);
    await repository.savePriceUpdate(second);
    const reopened = createMarketResearchRepository(pool);
    if (!reopened.listPriceUpdates) throw new Error('Repository lacks prices');
    expect(await reopened.listPriceUpdates(target.id)).toEqual([second, first]);
    expect(await reopened.findTarget(target.id)).toEqual(target);
  });

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
    const later = await repository.saveSnapshot(
      createImportedMarketSnapshot(
        { ...imported, capturedAt: '2026-10-28T01:00:00.000Z' },
        target,
        now,
      ),
    );
    const otherSearch = await repository.saveSnapshot(
      createImportedMarketSnapshot(
        {
          ...imported,
          sourceUrl: 'https://example.com/another-search',
        },
        target,
        now,
      ),
    );
    expect(await repository.listSnapshots()).toHaveLength(4);
    const savedRuns = await pool.query<{
      id: string;
      payload: { queryDigest: string };
    }>(
      'select id, payload from market_collection_runs where id = any($1::uuid[])',
      [[first.id, later.id, otherSearch.id]],
    );
    expect(savedRuns.rows).toHaveLength(3);
    const queryDigests = new Map(
      savedRuns.rows.map(({ id, payload }) => [id, payload.queryDigest]),
    );
    expect(queryDigests.get(first.id)).toBe(queryDigests.get(later.id));
    expect(queryDigests.get(otherSearch.id)).not.toBe(
      queryDigests.get(first.id),
    );
    const manualRuns = await pool.query<{ count: string }>(
      "select count(*)::text as count from market_collection_runs where payload->>'sourceId' = 'manual-import'",
    );
    expect(manualRuns.rows[0]?.count).toBe('4');
  });
});
