import { DomainError, type MaterialPriceProvider } from '@poe-worksmith/domain';
import { describe, expect, it } from 'vitest';

import {
  canonicalMaterialKey,
  PoeNinjaPriceProvider,
  StaticPriceProvider,
} from './poeNinja.js';
import type { PoeTradeFetch } from './poeTrade.js';

const currencyOverview = {
  lines: [
    {
      chaosEquivalent: 150.25,
      currencyTypeName: 'Divine Orb',
      detailsId: 'divine-orb',
    },
    {
      chaosEquivalent: 0.5,
      currencyTypeName: 'Primal Crystallised Lifeforce',
      detailsId: 'primal-crystallised-lifeforce',
    },
  ],
};
const itemOverview = {
  lines: [
    {
      chaosValue: 12.75,
      detailsId: 'large-cluster-jewel',
      name: 'Large Cluster Jewel',
    },
  ],
};

describe('poe.ninja price provider', () => {
  it('resolves current material/base prices and deduplicates canonical requests', async () => {
    const calls: string[] = [];
    const fetch: PoeTradeFetch = async (input) => {
      const url = String(input);
      calls.push(url);
      return Response.json(
        url.includes('/currency/') ? currencyOverview : itemOverview,
      );
    };
    const provider = new PoeNinjaPriceProvider({
      baseUrl: 'https://ninja.test',
      clock: () => new Date('2026-07-20T00:00:00.000Z'),
      fetch,
      userAgent: 'poe-worksmith/0.0.0 (contact: test@example.com)',
    });

    const [first, duplicate] = await Promise.all([
      provider.getPrice({
        league: 'Settlers',
        materialKey: 'Primal Crystallised Lifeforce',
      }),
      provider.getPrice({
        league: 'Settlers',
        materialKey: 'primal_crystallised_lifeforce',
      }),
    ]);
    const base = await provider.getPrice({
      league: 'Settlers',
      materialKey: 'large-cluster-jewel',
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(
      'https://ninja.test/poe1/api/economy/stash/current/currency/overview?league=Settlers&type=Currency',
    );
    expect(calls[1]).toBe(
      'https://ninja.test/poe1/api/economy/stash/current/item/overview?league=Settlers&type=BaseType',
    );
    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({
      chaosAmount: '0.5',
      fetchedAt: new Date('2026-07-20T00:00:00.000Z'),
      materialKey: 'primal-crystallised-lifeforce',
      original: { amount: '0.5', currency: 'chaos' },
      provider: 'poe-ninja',
    });
    expect(base.chaosAmount).toBe('12.75');
  });

  it('converts currencies from one cached overview', async () => {
    let calls = 0;
    const provider = new PoeNinjaPriceProvider({
      baseUrl: 'https://ninja.test',
      fetch: async () => {
        calls += 1;
        return Response.json(currencyOverview);
      },
      userAgent: 'poe-worksmith/0.0.0 (contact: test@example.com)',
    });

    await expect(
      provider.getRate({
        fromCurrency: 'divine',
        league: 'Settlers',
        toCurrency: 'chaos',
      }),
    ).resolves.toMatchObject({ rate: '150.25' });
    await expect(
      provider.getRate({
        fromCurrency: 'chaos',
        league: 'Settlers',
        toCurrency: 'divine',
      }),
    ).resolves.toMatchObject({ rate: '0.006655574043' });
    expect(calls).toBe(1);
  });

  it('returns typed unknown, missing, and invalid-response errors', async () => {
    const provider = new PoeNinjaPriceProvider({
      baseUrl: 'https://ninja.test',
      fetch: async () => Response.json({ lines: [] }),
      materials: {
        unavailable: {
          detailsId: 'not-in-response',
          overview: 'item',
          type: 'BaseType',
        },
      },
      userAgent: 'poe-worksmith/0.0.0 (contact: test@example.com)',
    });

    await expect(
      provider.getPrice({ league: 'Settlers', materialKey: 'unknown' }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_MATERIAL' });
    await expect(
      provider.getPrice({ league: 'Settlers', materialKey: 'unavailable' }),
    ).rejects.toMatchObject({ code: 'MATERIAL_PRICE_MISSING' });

    const malformed = new PoeNinjaPriceProvider({
      baseUrl: 'https://ninja.test',
      fetch: async () => Response.json({ lines: [{ detailsId: 1 }] }),
      userAgent: 'poe-worksmith/0.0.0 (contact: test@example.com)',
    });
    await expect(
      malformed.getPrice({
        league: 'Settlers',
        materialKey: 'divine-orb',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
  });
});

describe('static fallback provider', () => {
  const provider = new StaticPriceProvider({
    materials: {
      'manual-base': {
        original: { amount: '2', currency: 'divine' },
        updatedAt: new Date('2026-07-19T00:00:00.000Z'),
      },
      unavailable: {
        original: null,
        updatedAt: new Date('2026-07-19T00:00:00.000Z'),
      },
    },
    ratesToChaos: { divine: '150.25' },
    ratesUpdatedAt: new Date('2026-07-19T00:00:00.000Z'),
  });

  it('normalizes manual prices while preserving original currency', async () => {
    const injected: MaterialPriceProvider = provider;
    await expect(
      injected.getPrice({ league: 'Settlers', materialKey: 'manual_base' }),
    ).resolves.toMatchObject({
      chaosAmount: '300.5',
      original: { amount: '2', currency: 'divine' },
      provider: 'static-prices',
    });
  });

  it('converts currency in both directions', async () => {
    await expect(
      provider.getRate({
        fromCurrency: 'divine',
        league: 'Settlers',
        toCurrency: 'chaos',
      }),
    ).resolves.toMatchObject({ rate: '150.25' });
    await expect(
      provider.getRate({
        fromCurrency: 'chaos',
        league: 'Settlers',
        toCurrency: 'divine',
      }),
    ).resolves.toMatchObject({ rate: '0.006655574043' });
  });

  it('distinguishes unknown material, missing price, and unsupported currency', async () => {
    for (const [materialKey, code] of [
      ['unknown', 'UNKNOWN_MATERIAL'],
      ['unavailable', 'MATERIAL_PRICE_MISSING'],
    ] as const) {
      const error = await provider
        .getPrice({ league: 'Settlers', materialKey })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code });
    }
    await expect(
      provider.getRate({
        fromCurrency: 'mirror',
        league: 'Settlers',
        toCurrency: 'chaos',
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CURRENCY' });
  });
});

it('canonicalizes material keys deterministically', () => {
  expect(canonicalMaterialKey(' Primal_Crystallised Lifeforce ')).toBe(
    'primal-crystallised-lifeforce',
  );
});
