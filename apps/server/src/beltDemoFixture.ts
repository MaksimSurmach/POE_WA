import type {
  MarketSnapshotImport,
  MarketTargetInput,
} from '@poe-worksmith/contracts';

/** Synthetic only. The same UTC day generates the same target and observation. */
export function beltDemoFixture(now = new Date()) {
  const capturedAt = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const price = (amount: number) => ({
    source: 'manual' as const,
    amount,
    currency: 'chaos' as const,
    league: 'Demo',
    patch: '3.29',
    capturedAt,
    dataKind: 'demo' as const,
    url: 'https://example.com/demo',
    notes: 'Synthetic fixture; not a market quote.',
  });
  const target: MarketTargetInput = {
    name: 'DEMO — учебный редкий Stygian Vise',
    game: 'poe1',
    realm: 'pc',
    league: 'Demo',
    patch: '3.29',
    slot: 'Belt',
    baseTypes: ['Stygian Vise'],
    builds: ['Synthetic example'],
    requiredMods: ['Fixture: life ≥ 80'],
    sources: [
      {
        title: 'Synthetic fixture, not a real build',
        url: 'https://example.com/demo',
        kind: 'manual',
        notes: 'DEMO only',
      },
    ],
    beltRules: {
      version: 1,
      minItemLevel: 84,
      influences: [],
      corrupted: false,
      mods: [{ id: 'life', minValue: 80 }],
    },
    beltCraftMethod: {
      version: 1,
      name: 'Synthetic repeated roll',
      sourceUrl: 'https://example.com/demo',
      assumptions:
        'DEMO: independent attempts, same reusable base; no salvage, fees or finishing costs.',
      steps: ['Repeat synthetic roll until life ≥ 80.'],
      rulesComplete: true,
      repeatOnSameBase: true,
      success: { mode: 'probability', probability: 0.25 },
      basePrice: price(10),
      materials: [
        {
          id: 'fixture-orb',
          label: 'Fixture Orb',
          quantityPerAttempt: 1,
          price: price(2),
        },
      ],
    },
  };
  const observation = (targetId: string): MarketSnapshotImport => ({
    targetId,
    capturedAt,
    sourceUrl: 'https://example.com/demo',
    notes: 'Synthetic DEMO listings; no real market data.',
    currency: 'chaos',
    dataKind: 'demo',
    listings: [40, 45, 50, 55, 60].map((amount, index) => ({
      externalId: `demo-${index}`,
      price: amount,
      item: {
        baseType: 'Stygian Vise',
        rarity: 'rare',
        league: 'Demo',
        patch: '3.29',
        currency: 'chaos',
        itemLevel: 84,
        corrupted: false,
        influences: [],
        seller: `fixture-${index}`,
        status: 'listed',
        mods: [{ id: 'life', value: 90 }],
      },
    })),
  });
  return { target, observation };
}
