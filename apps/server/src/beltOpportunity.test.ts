import { describe, expect, it } from 'vitest';
import type { StoredMarketEconomySnapshot } from './marketEconomy.js';
import { beltDemoFixture } from './beltDemoFixture.js';
import { evaluateBeltOpportunity } from './beltOpportunity.js';
import {
  createImportedMarketSnapshot,
  createMarketTarget,
} from './marketResearch.js';

const now = new Date('2026-10-29T12:00:00.000Z');
function fixture() {
  const definition = beltDemoFixture(now);
  const target = createMarketTarget(definition.target, now);
  const snapshot = createImportedMarketSnapshot(
    definition.observation(target.id),
    target,
    now,
  );
  return { definition, target, snapshot };
}
describe('belt opportunity', () => {
  it('uses existing economics for a clearly synthetic, fully traceable example', async () => {
    const { target, snapshot } = fixture();
    const result = await evaluateBeltOpportunity(
      target,
      snapshot,
      undefined,
      now.getTime(),
    );
    expect(result).toMatchObject({
      status: 'CALCULATED',
      dataKind: 'demo',
      calculation: {
        expectedCraftCost: '18',
        askingPrice: '40',
        spread: '22',
        currency: 'chaos',
        breakdown: { expectedAttempts: '4' },
      },
    });
    expect(result.comparison?.independentSellers).toBe(5);
  });
  it('separates calculation readiness from a positive, zero or negative spread', async () => {
    const { target, snapshot } = fixture();
    for (const [price, expected] of [
      [40, 'POSITIVE'],
      [18, 'NON_POSITIVE'],
      [12, 'NON_POSITIVE'],
    ] as const) {
      const result = await evaluateBeltOpportunity(
        target,
        {
          ...snapshot,
          listings: snapshot.listings.map((entry) => ({ ...entry, price })),
        },
        undefined,
        now.getTime(),
      );
      expect(result.status).toBe('CALCULATED');
      expect(result.economicConclusion).toBe(expected);
    }
  });
  it('blocks stale, sparse, missing, mixed currency or mixed provenance', async () => {
    const { target, snapshot } = fixture();
    expect(
      (
        await evaluateBeltOpportunity(
          target,
          snapshot,
          undefined,
          now.getTime() + 2 * 86400000,
        )
      ).status,
    ).toBe('INSUFFICIENT_DATA');
    expect(
      (
        await evaluateBeltOpportunity(
          target,
          { ...snapshot, listings: snapshot.listings.slice(0, 1) },
          undefined,
          now.getTime(),
        )
      ).calculation,
    ).toBeNull();
    const method = target.beltCraftMethod;
    if (!method || method.basePrice.source !== 'manual')
      throw new Error('Invalid fixture');
    for (const basePrice of [
      { ...method.basePrice, currency: 'divine' as const },
      { ...method.basePrice, dataKind: 'observed' as const },
      { ...method.basePrice, capturedAt: '2026-10-27T00:00:00.000Z' },
    ]) {
      const result = await evaluateBeltOpportunity(
        { ...target, beltCraftMethod: { ...method, basePrice } },
        snapshot,
        undefined,
        now.getTime(),
      );
      expect(result.calculation).toBeNull();
      expect(result.reasons.join(' ')).toContain('Base price');
    }
    expect(
      (await evaluateBeltOpportunity(target, null, undefined, now.getTime()))
        .status,
    ).toBe('INSUFFICIENT_DATA');
  });
  it('rejects invalid probability and does not rank unverified rules', async () => {
    const { definition, target, snapshot } = fixture();
    const method = target.beltCraftMethod;
    if (!method) throw new Error('Invalid fixture');
    expect(() =>
      createMarketTarget(
        {
          ...definition.target,
          beltCraftMethod: {
            ...method,
            success: { mode: 'probability', probability: 0 },
          },
        },
        now,
      ),
    ).toThrow();
    const result = await evaluateBeltOpportunity(
      { ...target, beltCraftMethod: { ...method, rulesComplete: false } },
      snapshot,
      undefined,
      now.getTime(),
    );
    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.calculation).toBeNull();
  });
  it('uses a selected matching material economy line but never uses BaseType as a base quote', async () => {
    const { target, snapshot } = fixture();
    const method = target.beltCraftMethod;
    if (!method || method.basePrice.source !== 'manual' || !method.materials[0])
      throw new Error('Invalid fixture');
    const id = '00000000-0000-4000-8000-000000000001';
    const stored: StoredMarketEconomySnapshot = {
      id,
      kind: 'economy-overview',
      schemaVersion: 1,
      source: 'poe.ninja',
      game: 'poe1',
      endpoint: 'https://poe.ninja/api/data/itemoverview',
      payloadHash: 'a'.repeat(64),
      capturedAt: snapshot.capturedAt,
      sourceUpdatedAt: null,
      raw: {},
      league: 'Demo',
      category: 'Essence',
      priceBasis: 'stash-estimate',
      lines: [
        {
          id: 'fixture',
          name: 'Fixture Orb',
          detailsId: null,
          baseType: null,
          price: { amount: 2, currency: 'chaos' },
          listingCount: null,
          observationCount: null,
          tradedVolume: null,
        },
      ],
    };
    const observed = { ...snapshot, dataKind: 'observed' as const };
    const reference = {
      source: 'economy' as const,
      snapshotId: id,
      lineId: 'fixture',
      patch: '3.29',
    };
    const realMethod = {
      ...method,
      basePrice: { ...method.basePrice, dataKind: 'observed' as const },
      materials: [{ ...method.materials[0], price: reference }],
    };
    const repo = { find: async () => stored };
    expect(
      (
        await evaluateBeltOpportunity(
          { ...target, beltCraftMethod: realMethod },
          observed,
          repo,
          now.getTime(),
        )
      ).calculation?.expectedCraftCost,
    ).toBe('18');
    const wrongLeague = { find: async () => ({ ...stored, league: 'Other' }) };
    expect(
      (
        await evaluateBeltOpportunity(
          { ...target, beltCraftMethod: realMethod },
          observed,
          wrongLeague,
          now.getTime(),
        )
      ).calculation,
    ).toBeNull();
    const baseMethod = { ...realMethod, basePrice: reference };
    expect(
      (
        await evaluateBeltOpportunity(
          { ...target, beltCraftMethod: baseMethod },
          observed,
          repo,
          now.getTime(),
        )
      ).calculation,
    ).toBeNull();
  });
});
