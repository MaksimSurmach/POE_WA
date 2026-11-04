import { describe, expect, it } from 'vitest';
import type {
  MarketEconomyRepository,
  StoredMarketEconomySnapshot,
} from './marketEconomy.js';
import type { MarketEconomyAttempt } from '@poe-worksmith/contracts';
import { summarizeEconomy, newEconomyAttempt } from './marketEconomy.js';
import { readCraftingPrices } from './craftingPrices.js';

const now = new Date('2026-11-04T13:00:00Z');
function snapshot(
  category: 'Currency' | 'Essence',
  currency = 'chaos',
): StoredMarketEconomySnapshot {
  return {
    id:
      category === 'Currency'
        ? '00000000-0000-4000-8000-000000000001'
        : '00000000-0000-4000-8000-000000000002',
    schemaVersion: 1,
    kind: 'economy-overview',
    source: 'poe.ninja',
    game: 'poe1',
    league: 'Allflame',
    category,
    endpoint: 'https://poe.ninja/example',
    payloadHash: 'a'.repeat(64),
    capturedAt: now.toISOString(),
    sourceUpdatedAt: null,
    priceBasis: 'currency-exchange',
    raw: {},
    lines: [
      {
        id: category,
        detailsId: category === 'Currency' ? 'divine-orb' : 'essence-of-horror',
        name: category === 'Currency' ? 'Divine Orb' : 'Essence of Horror',
        baseType: null,
        price: { amount: category === 'Currency' ? 400 : 2, currency },
        listingCount: null,
        observationCount: null,
        tradedVolume: null,
      },
    ],
  };
}
function repository(
  values: StoredMarketEconomySnapshot[],
  attempts: MarketEconomyAttempt[] = [],
): MarketEconomyRepository {
  return {
    listAttempts: async () => attempts,
    latest: async (_league, category) => {
      const s = values.find((v) => v.category === category);
      return s ? summarizeEconomy(s) : null;
    },
    find: async (id) => values.find((s) => s.id === id) ?? null,
  } as MarketEconomyRepository;
}
describe('guide material quotes', () => {
  it.each(['hit', 'failed', 'other-league', 'future'])(
    'does not refresh a stale payload from a %s attempt',
    async (mode) => {
      const value = {
        ...snapshot('Essence'),
        capturedAt: '2026-11-04T12:00:00Z',
      };
      const attempt = {
        ...newEconomyAttempt({
          league: mode === 'other-league' ? 'Standard' : 'Allflame',
          category: 'Essence',
          startedAt: now,
        }),
        status:
          mode === 'failed' ? ('failed' as const) : ('succeeded' as const),
        cacheStatus:
          mode === 'hit' ? ('hit' as const) : ('revalidated' as const),
        completedAt:
          mode === 'future' ? '2026-11-04T14:00:00Z' : now.toISOString(),
        snapshotId: value.id,
      };
      expect(
        (
          await readCraftingPrices({
            league: 'Allflame',
            repository: repository([value], [attempt]),
            now,
            maximumAgeMs: 60_000,
          })
        ).quotes,
      ).toEqual([]);
    },
  );
  it('converts current same-league quotes using the shared currency evidence', async () => {
    const result = await readCraftingPrices({
      league: 'Allflame',
      repository: repository([
        snapshot('Currency'),
        snapshot('Essence', 'divine'),
      ]),
      now,
      maximumAgeMs: 60_000,
    });
    expect(
      result.quotes.find((q) => q.itemId === 'essence-of-horror'),
    ).toMatchObject({ chaos: 800, expiresAt: '2026-11-04T13:01:00.000Z' });
  });
  it.each(['expired', 'wrong-league', 'future'])(
    'withholds %s snapshots rather than supplying zero prices',
    async (mode) => {
      const s = snapshot('Essence');
      const invalid = {
        ...s,
        ...(mode === 'wrong-league'
          ? { league: 'Standard' }
          : {
              capturedAt:
                mode === 'expired'
                  ? '2026-11-04T12:00:00Z'
                  : '2026-11-04T14:00:00Z',
            }),
      };
      expect(
        (
          await readCraftingPrices({
            league: 'Allflame',
            repository: repository([invalid]),
            now,
            maximumAgeMs: 60_000,
          })
        ).quotes,
      ).toEqual([]);
    },
  );
  it('requires a fresh exchange rate for divine quotes and supports confirmed revalidation', async () => {
    const stale = {
      ...snapshot('Currency'),
      capturedAt: '2026-11-04T12:00:00Z',
    };
    const value = snapshot('Essence', 'divine');
    const input = { league: 'Allflame', now, maximumAgeMs: 60_000 };
    expect(
      (
        await readCraftingPrices({
          ...input,
          repository: repository([stale, value]),
        })
      ).quotes,
    ).toEqual([]);
    expect(
      (
        await readCraftingPrices({
          ...input,
          repository: repository(
            [stale, value],
            [
              {
                ...newEconomyAttempt({
                  league: 'Allflame',
                  category: 'Currency',
                  startedAt: now,
                }),
                status: 'succeeded',
                cacheStatus: 'revalidated',
                completedAt: now.toISOString(),
                snapshotId: stale.id,
              },
            ],
          ),
        })
      ).quotes,
    ).toHaveLength(2);
  });
  it('returns an empty set when no current league is known', async () => {
    expect(
      (
        await readCraftingPrices({
          league: null,
          now,
          maximumAgeMs: 60_000,
          repository: repository([snapshot('Currency')]),
        })
      ).quotes,
    ).toEqual([]);
  });
});
