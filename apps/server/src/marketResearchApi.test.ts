import type {
  MarketResearchSnapshot,
  MarketTarget,
} from '@poe-worksmith/contracts';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { buildApi } from './api.js';
import {
  type MarketResearchRepository,
  summarizeMarketSnapshot,
} from './marketResearch.js';

const targetInput = {
  name: 'Curated belt target',
  game: 'poe1',
  realm: 'pc',
  league: 'Standard',
  patch: '3.29',
  slot: 'Belt',
  baseTypes: ['Stygian Vise'],
  builds: ['Example'],
  requiredMods: ['90+ life'],
  sources: [],
};

function inMemoryTestRepository(): MarketResearchRepository {
  const targets = new Map<string, MarketTarget>();
  const snapshots = new Map<string, MarketResearchSnapshot>();
  return {
    listTargets: async () => [...targets.values()],
    findTarget: async (id) =>
      [...targets.values()].find((target) => target.id === id) ?? null,
    saveTarget: async (target) => {
      const existing = targets.get(target.digest);
      if (existing) return existing;
      targets.set(target.digest, target);
      return target;
    },
    listSnapshots: async () =>
      [...snapshots.values()].map(summarizeMarketSnapshot),
    findSnapshot: async (id) =>
      [...snapshots.values()].find((snapshot) => snapshot.id === id) ?? null,
    saveSnapshot: async (snapshot) => {
      const existing = snapshots.get(snapshot.digest);
      if (existing) return existing;
      snapshots.set(snapshot.digest, snapshot);
      return snapshot;
    },
  };
}

function testApi(repository?: MarketResearchRepository) {
  return buildApi(
    pino({ level: 'silent' }),
    async () => {},
    async () => ({ active: null, published: null }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { marketResearch: repository },
  );
}

describe('market workbench API', () => {
  it('imports and analyzes a synthetic belt through the API without changing its raw payload', async () => {
    const api = testApi(inMemoryTestRepository());
    try {
      const created = await api.inject({
        method: 'POST',
        url: '/api/market/targets',
        payload: {
          ...targetInput,
          beltRules: {
            version: 1,
            minItemLevel: 84,
            influences: [],
            corrupted: false,
            mods: [{ id: 'life', minValue: 80 }],
          },
        },
      });
      const target = created.json().data;
      const item = {
        baseType: 'Stygian Vise',
        rarity: 'rare',
        league: 'Standard',
        patch: '3.29',
        currency: 'chaos',
        itemLevel: 84,
        corrupted: false,
        influences: [],
        seller: 'fixture',
        status: 'listed',
        mods: [{ id: 'life', value: 90 }],
      };
      const imported = await api.inject({
        method: 'POST',
        url: '/api/market/snapshots/import',
        payload: {
          targetId: target.id,
          capturedAt: new Date().toISOString(),
          sourceUrl: 'https://example.com/demo',
          currency: 'chaos',
          dataKind: 'demo',
          listings: [{ price: 10, item }],
        },
      });
      expect(imported.statusCode).toBe(201);
      expect(imported.json().data.listings[0].item).toEqual(item);
      const analysis = await api.inject({
        method: 'GET',
        url: `/api/market/snapshots/${imported.json().data.id}/belt-analysis/v1`,
      });
      expect(analysis.statusCode).toBe(200);
      expect(analysis.json().data.rows[0].status).toBe('MATCH');
      expect(analysis.json().data.status).toBe('INSUFFICIENT_DATA');
    } finally {
      await api.close();
    }
  });

  it('creates a target, imports evidence idempotently and serves summaries separately from raw rows', async () => {
    const api = testApi(inMemoryTestRepository());
    try {
      const created = await api.inject({
        method: 'POST',
        url: '/api/market/targets',
        payload: targetInput,
      });
      expect(created.statusCode).toBe(201);
      const target = created.json().data;
      const payload = {
        targetId: target.id,
        capturedAt: '2026-01-01T00:00:00.000Z',
        sourceUrl: 'https://example.com/observations',
        currency: 'chaos',
        dataKind: 'observed',
        listings: [
          {
            externalId: 'listing-a',
            price: 50,
            item: { baseType: 'Stygian Vise', league: 'Standard' },
          },
        ],
      };
      const imported = await api.inject({
        method: 'POST',
        url: '/api/market/snapshots/import',
        payload,
      });
      const repeated = await api.inject({
        method: 'POST',
        url: '/api/market/snapshots/import',
        payload,
      });
      expect(imported.statusCode).toBe(201);
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json().data).toEqual(imported.json().data);
      const overview = await api.inject({ method: 'GET', url: '/api/market' });
      expect(overview.json().data.storage).toBe('postgres');
      expect(overview.json().data.snapshots).toHaveLength(1);
      expect(overview.json().data.snapshots[0]).not.toHaveProperty('listings');
      const detail = await api.inject({
        method: 'GET',
        url: `/api/market/snapshots/${imported.json().data.id}`,
      });
      expect(detail.json().data.listings).toEqual(payload.listings);
    } finally {
      await api.close();
    }
  });

  it('exposes unavailable storage honestly and refuses to pretend an import was saved', async () => {
    const api = testApi();
    try {
      const read = await api.inject('/api/market');
      expect(read.statusCode).toBe(200);
      expect(read.json().data).toMatchObject({
        storage: 'unavailable',
        targets: [],
        snapshots: [],
      });
      expect(
        read
          .json()
          .data.sources.find(
            (source: { id: string }) => source.id === 'poe_ninja_economy',
          ).status,
      ).toBe('planned');
      const write = await api.inject({
        method: 'POST',
        url: '/api/market/targets',
        payload: targetInput,
      });
      expect(write.statusCode).toBe(503);
      expect(write.json().error.code).toBe('PERSISTENCE_UNAVAILABLE');
    } finally {
      await api.close();
    }
  });

  it('rejects malformed and oversized requests with useful HTTP status codes', async () => {
    const api = testApi(inMemoryTestRepository());
    try {
      const malformed = await api.inject({
        method: 'POST',
        url: '/api/market/snapshots/import',
        headers: { 'content-type': 'application/json' },
        payload: '{',
      });
      expect(malformed.statusCode).toBe(400);
      const oversized = await api.inject({
        method: 'POST',
        url: '/api/market/snapshots/import',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ extra: 'x'.repeat(2 * 1024 * 1024) }),
      });
      expect(oversized.statusCode).toBe(413);
      const missing = await api.inject('/api/market/snapshots/not-an-id');
      expect(missing.statusCode).toBe(404);
    } finally {
      await api.close();
    }
  });
});
