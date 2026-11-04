import type { CraftingPrices } from '@poe-worksmith/contracts';
import {
  verifyEconomySnapshot,
  type MarketEconomyRepository,
  type StoredMarketEconomySnapshot,
} from './marketEconomy.js';
import { convertMarketQuote } from './marketCurrency.js';

export async function readCraftingPrices(input: {
  league: string | null;
  repository?: MarketEconomyRepository | undefined;
  now: Date;
  maximumAgeMs: number;
}): Promise<CraftingPrices> {
  const result: CraftingPrices = {
    league: input.league,
    checkedAt: input.now.toISOString(),
    quotes: [],
  };
  if (!input.league || !input.repository) return result;
  const repository = input.repository;
  const attempts = await repository.listAttempts();
  const snapshots = await Promise.all(
    (['Currency', 'Essence', 'Fossil', 'Resonator'] as const).map(
      async (category) => {
        const summary = await repository.latest(input.league!, category);
        const snapshot = verifyEconomySnapshot(
          summary ? await repository.find(summary.id) : null,
          attempts,
          input.now,
        );
        if (
          !snapshot ||
          snapshot.league !== input.league ||
          snapshot.category !== category
        )
          return null;
        const verified = Date.parse(snapshot.verifiedAt ?? snapshot.capturedAt);
        const captured = Date.parse(snapshot.capturedAt);
        return Number.isFinite(captured) &&
          captured <= verified &&
          Number.isFinite(verified) &&
          verified <= input.now.getTime() &&
          verified + input.maximumAgeMs > input.now.getTime()
          ? snapshot
          : null;
      },
    ),
  );
  const exchange = snapshots.find((s) => s?.category === 'Currency');
  const cache = new Map(
    snapshots
      .filter((s): s is StoredMarketEconomySnapshot => s !== null)
      .map((s) => [s.id, s]),
  );
  for (const snapshot of snapshots) {
    if (!snapshot) continue;
    const verifiedAt = snapshot.verifiedAt ?? snapshot.capturedAt;
    for (const line of snapshot.lines) {
      if (
        !line.detailsId ||
        !line.name ||
        line.price.amount === null ||
        !Number.isFinite(line.price.amount) ||
        line.price.amount <= 0
      )
        continue;
      const quote = await convertMarketQuote({
        money: {
          amount: String(line.price.amount),
          currency: line.price.currency,
        },
        currency: 'chaos',
        target: { league: input.league },
        capturedAt: verifiedAt,
        ...(exchange ? { exchangeSnapshotId: exchange.id } : {}),
        economy: { find: async (id) => cache.get(id) ?? null },
        now: input.now.getTime(),
        dataKind: 'observed',
      });
      if (!quote) continue;
      const chaos = Number(quote.money.amount);
      if (!Number.isFinite(chaos) || chaos <= 0) continue;
      const oldest = Math.min(
        Date.parse(verifiedAt),
        quote.exchange ? Date.parse(quote.exchange.verifiedAt) : Infinity,
      );
      result.quotes.push({
        itemId: line.detailsId,
        name: line.name,
        chaos,
        capturedAt: snapshot.capturedAt,
        verifiedAt,
        expiresAt: new Date(oldest + input.maximumAgeMs).toISOString(),
      });
    }
  }
  return result;
}
