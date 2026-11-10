import { Decimal } from 'decimal.js';

const ExactDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});
const moneyScale = 8;

export type DecimalMoney = Readonly<{
  amount: string;
  currency: string;
}>;

/** User-entered spending scenario, not a probability model or market valuation. */
export function calculateCostScenario(input: {
  bases: string;
  other: string;
  sale: string;
  materials: readonly { quantity: string; unitPrice: string }[];
}) {
  const parse = (value: string) => {
    if (!/^\d+(?:\.\d{1,8})?$/.test(value.trim())) return null;
    const amount = new ExactDecimal(value.trim());
    return amount.lte('1000000000000') ? amount : null;
  };
  const bases = parse(input.bases),
    other = parse(input.other);
  if (bases === null || other === null) return null;
  let cost = bases.add(other);
  for (const material of input.materials) {
    const quantity = parse(material.quantity);
    if (quantity === null) return null;
    if (quantity.isZero()) continue;
    const unitPrice = parse(material.unitPrice);
    if (unitPrice === null) return null;
    cost = cost.add(quantity.mul(unitPrice));
  }
  const sale = parse(input.sale);
  const profit = sale?.sub(cost) ?? null;
  return {
    cost: cost.toDecimalPlaces(moneyScale).toFixed(),
    profit: profit?.toDecimalPlaces(moneyScale).toFixed() ?? null,
    roi:
      profit && cost.gt(0)
        ? profit.div(cost).mul(100).toDecimalPlaces(6).toFixed()
        : null,
  };
}

/** Arithmetic only; the caller must validate the exchange observation's league and time. */
export function convertChaosDivineQuote(
  money: DecimalMoney,
  currency: 'chaos' | 'divine',
  chaosPerDivine: number,
): DecimalMoney {
  if (
    !['chaos', 'divine'].includes(money.currency) ||
    !Number.isFinite(chaosPerDivine) ||
    chaosPerDivine <= 0 ||
    !decimal(money.amount).isFinite() ||
    decimal(money.amount).lte(0)
  )
    throw new TypeError('Invalid currency quote');
  return {
    amount: format(
      round(
        money.currency === currency
          ? decimal(money.amount)
          : currency === 'chaos'
            ? decimal(money.amount).mul(chaosPerDivine)
            : decimal(money.amount).div(chaosPerDivine),
      ),
    ),
    currency,
  };
}

function decimal(value: Decimal.Value) {
  return new ExactDecimal(value);
}

function round(value: Decimal) {
  return value.toDecimalPlaces(moneyScale, Decimal.ROUND_HALF_UP);
}

function format(value: Decimal) {
  const fixed = round(value).toFixed(moneyScale);
  return fixed.replace(/(?:\.0+|(?<fraction>\.\d+?)0+)$/, '$<fraction>') || '0';
}
