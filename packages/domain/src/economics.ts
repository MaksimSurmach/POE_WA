import { Decimal } from 'decimal.js';

import type { DomainErrorCode } from './errors.js';
import {
  type MarketAggregation,
  selectPriceEstimate,
} from './priceEstimators.js';
import type { CanonicalRecipeV1 } from './recipeSchema.js';

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

export type EconomicsFailureReasonCode =
  | 'base_price_missing'
  | 'currency_mismatch'
  | 'finishing_price_missing'
  | 'invalid_price'
  | 'material_price_missing'
  | 'sale_price_missing';

export type EconomicsFailureReason = Readonly<{
  code: EconomicsFailureReasonCode;
  id: string;
  message: string;
}>;

export type CostLine = Readonly<{
  id: string;
  label: string;
  quantity: string;
  total: DecimalMoney;
  unitPrice: DecimalMoney;
}>;

export type EconomicsBreakdown = Readonly<{
  base: CostLine;
  expectedAttempts: string;
  expectedCraftCost: DecimalMoney;
  expectedMaterials: DecimalMoney;
  finishing: readonly CostLine[];
  finishingTotal: DecimalMoney;
  materialsPerAttempt: DecimalMoney;
  materials: readonly CostLine[];
}>;

export type RecipeEconomics = Readonly<{
  breakdown: EconomicsBreakdown;
  estimatedSalePrice: DecimalMoney;
  marginPercent: string;
  profit: DecimalMoney;
  selectedEstimatorId: string;
}>;

export type EconomicsCalculationResult =
  | Readonly<{
      errorCode: DomainErrorCode;
      ok: false;
      reasons: readonly EconomicsFailureReason[];
    }>
  | Readonly<{ ok: true; value: RecipeEconomics }>;

export function calculateRecipeEconomics(input: {
  aggregation: MarketAggregation | null;
  basePrice: DecimalMoney | null;
  currency: string;
  finishingPrices: Readonly<Record<string, DecimalMoney | null | undefined>>;
  materialPrices: Readonly<Record<string, DecimalMoney | null | undefined>>;
  recipe: CanonicalRecipeV1;
}): EconomicsCalculationResult {
  const currency = input.currency.trim();
  const reasons: EconomicsFailureReason[] = [];
  if (currency.length === 0) {
    reasons.push({
      code: 'currency_mismatch',
      id: 'currency',
      message: 'Calculation currency is empty.',
    });
  }

  const basePrice = readRequiredPrice({
    currency,
    id: 'base',
    missingCode: 'base_price_missing',
    money: input.basePrice,
    reasons,
  });
  const materialInputs = input.recipe.materials.map((material) => ({
    material,
    price: readRequiredPrice({
      currency,
      id: material.id,
      missingCode: 'material_price_missing',
      money: input.materialPrices[material.id],
      reasons,
    }),
  }));
  const finishingInputs = input.recipe.finishingCosts.map((finishing) => ({
    finishing,
    price: readRequiredPrice({
      currency,
      id: finishing.id,
      missingCode: 'finishing_price_missing',
      money: input.finishingPrices[finishing.id],
      reasons,
    }),
  }));

  let selectedEstimatorId = estimatorId(input.recipe.estimator);
  let salePrice: Decimal | null = null;
  if (!input.aggregation) {
    reasons.push({
      code: 'sale_price_missing',
      id: selectedEstimatorId,
      message: 'No market aggregation is available.',
    });
  } else {
    const selected = selectPriceEstimate(
      input.aggregation,
      input.recipe.estimator,
    );
    selectedEstimatorId = selected.id;
    salePrice = readRequiredPrice({
      currency,
      id: selected.id,
      missingCode: 'sale_price_missing',
      money: selected.price,
      reasons,
    });
    if (!selected.price && selected.reason) {
      const reason = reasons.at(-1);
      if (reason?.code === 'sale_price_missing') {
        reasons[reasons.length - 1] = {
          ...reason,
          message: `Estimator unavailable: ${selected.reason}.`,
        };
      }
    }
  }

  if (
    reasons.length > 0 ||
    !basePrice ||
    !salePrice ||
    materialInputs.some(({ price }) => !price) ||
    finishingInputs.some(({ price }) => !price)
  ) {
    return {
      errorCode: failureCode(reasons),
      ok: false,
      reasons,
    };
  }

  const expectedAttempts = round(
    input.recipe.success.mode === 'expected_attempts'
      ? decimal(input.recipe.success.expectedAttempts)
      : new ExactDecimal(1).div(decimal(input.recipe.success.probability)),
  );
  const materials = materialInputs.map(({ material, price }) =>
    costLine(
      material.id,
      material.label,
      decimal(material.quantityPerAttempt),
      price!,
      currency,
    ),
  );
  const materialsPerAttempt = sum(
    materials.map(({ total }) => decimal(total.amount)),
  );
  const expectedMaterials = round(materialsPerAttempt.mul(expectedAttempts));
  const finishing = finishingInputs.map(({ finishing: item, price }) =>
    costLine(item.id, item.label, decimal(item.quantity), price!, currency),
  );
  const finishingTotal = sum(
    finishing.map(({ total }) => decimal(total.amount)),
  );
  const expectedCraftCost = round(
    basePrice.add(expectedMaterials).add(finishingTotal),
  );
  const profit = round(salePrice.sub(expectedCraftCost));
  const marginPercent = round(profit.div(salePrice).mul(100));
  const money = (value: Decimal): DecimalMoney => ({
    amount: format(value),
    currency,
  });

  return {
    ok: true,
    value: {
      breakdown: {
        base: costLine(
          'base',
          input.recipe.baseRequirements.baseType,
          new ExactDecimal(1),
          basePrice,
          currency,
        ),
        expectedAttempts: format(expectedAttempts),
        expectedCraftCost: money(expectedCraftCost),
        expectedMaterials: money(expectedMaterials),
        finishing,
        finishingTotal: money(finishingTotal),
        materials,
        materialsPerAttempt: money(materialsPerAttempt),
      },
      estimatedSalePrice: money(salePrice),
      marginPercent: format(marginPercent),
      profit: money(profit),
      selectedEstimatorId,
    },
  };
}

function readRequiredPrice(options: {
  currency: string;
  id: string;
  missingCode: Extract<
    EconomicsFailureReasonCode,
    | 'base_price_missing'
    | 'finishing_price_missing'
    | 'material_price_missing'
    | 'sale_price_missing'
  >;
  money: DecimalMoney | null | undefined;
  reasons: EconomicsFailureReason[];
}): Decimal | null {
  if (!options.money) {
    options.reasons.push({
      code: options.missingCode,
      id: options.id,
      message: 'Required price is missing.',
    });
    return null;
  }
  if (options.money.currency !== options.currency) {
    options.reasons.push({
      code: 'currency_mismatch',
      id: options.id,
      message: `Expected ${options.currency}, received ${options.money.currency}.`,
    });
    return null;
  }

  let value: Decimal;
  try {
    value = decimal(options.money.amount);
  } catch {
    options.reasons.push({
      code: 'invalid_price',
      id: options.id,
      message: 'Price is not a valid decimal.',
    });
    return null;
  }
  if (!value.isFinite() || value.lte(0)) {
    options.reasons.push({
      code: value.eq(0) ? options.missingCode : 'invalid_price',
      id: options.id,
      message: value.eq(0)
        ? 'Required price is zero.'
        : 'Price must be positive.',
    });
    return null;
  }
  return round(value);
}

function costLine(
  id: string,
  label: string,
  quantity: Decimal,
  unitPrice: Decimal,
  currency: string,
): CostLine {
  return {
    id,
    label,
    quantity: format(quantity),
    total: { amount: format(round(quantity.mul(unitPrice))), currency },
    unitPrice: { amount: format(unitPrice), currency },
  };
}

function sum(values: readonly Decimal[]) {
  return round(values.reduce((total, value) => total.add(value), decimal(0)));
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

function failureCode(
  reasons: readonly EconomicsFailureReason[],
): DomainErrorCode {
  if (reasons.some(({ code }) => code === 'currency_mismatch')) {
    return 'UNSUPPORTED_CURRENCY';
  }
  if (reasons.some(({ code }) => code === 'invalid_price')) {
    return 'CALCULATION_INPUT_INVALID';
  }
  if (
    reasons.some(({ code }) =>
      [
        'base_price_missing',
        'finishing_price_missing',
        'material_price_missing',
      ].includes(code),
    )
  ) {
    return 'MATERIAL_PRICE_MISSING';
  }
  if (reasons.some(({ code }) => code === 'sale_price_missing')) {
    return 'NO_LISTINGS';
  }
  return 'CALCULATION_FAILED';
}

function estimatorId(configuration: CanonicalRecipeV1['estimator']) {
  switch (configuration.strategy) {
    case 'cheapest':
      return 'cheapest';
    case 'nth_cheapest':
      return `${configuration.n}-cheapest`;
    case 'median_top_n':
      return `median-top-${configuration.n}`;
    case 'mean_top_n':
      return `mean-top-${configuration.n}`;
    case 'percentile':
      return `percentile-${configuration.percentile}`;
  }
}
