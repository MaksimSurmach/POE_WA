import type { MarketTarget } from '@poe-worksmith/contracts';
import {
  convertChaosDivineQuote,
  type DecimalMoney,
} from '@poe-worksmith/domain/economics';
import type { MarketEconomyRepository } from './marketEconomy.js';

/** A saved, contemporaneous Currency Exchange observation is required for every conversion. */
export async function convertMarketQuote(input: {
  money: DecimalMoney;
  currency: 'chaos' | 'divine';
  target: Pick<MarketTarget, 'league'>;
  capturedAt: string;
  exchangeSnapshotId?: string;
  economy?: Pick<MarketEconomyRepository, 'find'>;
  now: number;
  dataKind: 'observed' | 'demo';
}) {
  if (input.money.currency === input.currency)
    return { money: input.money, exchange: null };
  if (
    !input.exchangeSnapshotId ||
    !input.economy ||
    input.dataKind !== 'observed'
  )
    return null;
  const exchange = await input.economy.find(input.exchangeSnapshotId);
  const day = 86_400_000;
  if (
    !exchange ||
    exchange.league !== input.target.league ||
    exchange.category !== 'Currency' ||
    exchange.priceBasis !== 'currency-exchange' ||
    input.now < Date.parse(exchange.capturedAt) ||
    input.now - Date.parse(exchange.capturedAt) > day ||
    Math.abs(Date.parse(input.capturedAt) - Date.parse(exchange.capturedAt)) >
      day
  )
    return null;
  const divine = exchange.lines.find(
    (line) =>
      line.name === 'Divine Orb' &&
      line.price.currency === 'chaos' &&
      line.price.amount !== null,
  );
  const chaos = exchange.lines.find(
    (line) =>
      line.name === 'Chaos Orb' &&
      line.price.currency === 'divine' &&
      line.price.amount !== null,
  );
  const rate =
    divine?.price.amount ??
    (chaos?.price.amount ? 1 / chaos.price.amount : null);
  if (!rate || !['chaos', 'divine'].includes(input.money.currency)) return null;
  return {
    money: convertChaosDivineQuote(input.money, input.currency, rate),
    exchange: {
      snapshotId: exchange.id,
      capturedAt: exchange.capturedAt,
      league: exchange.league,
      chaosPerDivine: rate,
      url: exchange.endpoint,
    },
  };
}
