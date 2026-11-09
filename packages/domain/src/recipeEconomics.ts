import { Decimal } from 'decimal.js';

import { analyzeIndependentGeometric } from './craftingRisk.js';
import { isOutcomeAmount } from './outcomeModel.js';
import type { DecimalMoney } from './economics.js';
import type { CraftProcedure } from './recipeSchema.js';

const DecimalValue = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

/** Returns entered expected material usage per finished item, or null if unknown. */
export function expectedMethodMaterialUsage(
  method: CraftProcedure,
): Record<string, number> | null {
  const executions = new Map(
    method.expectedExecutions?.map(({ count, stepId }) => [stepId, count]),
  );
  const quantities = new Map<string, number>();

  for (const step of method.steps) {
    if (step.materials.length === 0) continue;
    const count = executions.get(step.id);
    if (count === undefined) return null;
    for (const material of step.materials) {
      if (material.quantity === null) return null;
      quantities.set(
        material.itemId,
        (quantities.get(material.itemId) ?? 0) + material.quantity * count,
      );
    }
  }

  return Object.fromEntries(
    [...quantities].sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function calculateMethodMaterialEconomics(input: {
  currency: string;
  materialPrices: Readonly<
    Record<string, { amount: string; currency: string } | null | undefined>
  >;
  method: CraftProcedure;
}) {
  const expectedExecutions = new Map(
    input.method.expectedExecutions?.map(({ count, stepId }) => [
      stepId,
      count,
    ]),
  );
  let expectedCost = new DecimalValue(0);
  let expectedCostAvailable = true;
  const stepAttemptCosts: (Decimal | null)[] = [];
  const steps = input.method.steps.map((step) => {
    let stepCost = new DecimalValue(0);
    let stepCostAvailable = true;
    const materials = step.materials.map((material) => {
      const price = input.materialPrices[material.itemId];
      if (!price || price.currency !== input.currency) {
        expectedCostAvailable = false;
        stepCostAvailable = false;
        return {
          costPerAttempt: null,
          itemId: material.itemId,
          quantityPerAttempt: material.quantity,
          unitPrice: null,
        };
      }
      if (material.quantity === null) {
        expectedCostAvailable = false;
        stepCostAvailable = false;
        return {
          costPerAttempt: null,
          itemId: material.itemId,
          quantityPerAttempt: null,
          unitPrice: price,
        };
      }
      const cost = new DecimalValue(price.amount).mul(material.quantity);
      stepCost = stepCost.add(cost);
      return {
        costPerAttempt: {
          amount: cost.toDecimalPlaces(8).toFixed(),
          currency: input.currency,
        },
        itemId: material.itemId,
        quantityPerAttempt: material.quantity,
        unitPrice: price,
      };
    });
    const executions = expectedExecutions.get(step.id);
    stepAttemptCosts.push(stepCostAvailable ? stepCost : null);
    if (step.materials.length > 0 && executions === undefined) {
      expectedCostAvailable = false;
    } else if (executions !== undefined) {
      expectedCost = expectedCost.add(stepCost.mul(executions));
    }
    return {
      action: step.action,
      continueWhen: step.continueWhen,
      failureAction: step.failureAction,
      id: step.id,
      materials,
      success: step.success ?? null,
      title: step.title,
    };
  });
  const hasOneStep = input.method.steps.length === 1;
  const oneStepCost = hasOneStep ? (stepAttemptCosts[0] ?? null) : null;
  return {
    expectedCost:
      expectedCostAvailable && input.method.expectedExecutions
        ? {
            amount: expectedCost.toDecimalPlaces(8).toFixed(),
            currency: input.currency,
          }
        : null,
    materialsPerAttempt:
      oneStepCost !== null
        ? {
            amount: oneStepCost.toDecimalPlaces(8).toFixed(),
            currency: input.currency,
          }
        : null,
    steps,
  };
}

export function singleItemCraftBudget(input: {
  currency: string;
  expectedCraftCost: string | null;
  expectedExecutions: CraftProcedure['expectedExecutions'];
  steps: ReturnType<typeof calculateMethodMaterialEconomics>['steps'];
}) {
  const probabilisticSteps = input.steps.filter(
    ({ success }) =>
      success && success.probability > 0 && success.probability < 1,
  );
  const [step] = probabilisticSteps;
  // shortcut: single geometric stage only; use simulateCraftingRisk for multi-stage budgets (Phase 6).
  if (
    input.expectedCraftCost === null ||
    probabilisticSteps.length !== 1 ||
    !step?.success
  )
    return null;
  const execution = input.expectedExecutions?.find(
    ({ stepId }) => stepId === step.id,
  );
  if (step.materials.length > 0 && !execution) return null;

  let attemptCost = new DecimalValue(0);
  // The displayed attempt costs round before multiplying by the execution count.
  for (const { unitPrice, quantityPerAttempt } of step.materials) {
    if (!unitPrice || quantityPerAttempt === null) return null;
    attemptCost = attemptCost.add(
      new DecimalValue(unitPrice.amount).mul(quantityPerAttempt),
    );
  }
  const successProbability = new DecimalValue(step.success.probability)
    .toSignificantDigits(12)
    .toFixed();
  const perAttemptCost = attemptCost.toDecimalPlaces(16).toFixed();
  const setupCost = new DecimalValue(input.expectedCraftCost)
    .sub(attemptCost.mul(execution?.count ?? 0))
    .toDecimalPlaces(8)
    .toFixed();
  if (![successProbability, perAttemptCost, setupCost].every(isOutcomeAmount))
    return null;
  const {
    costQuantiles: { p50, p90 },
  } = analyzeIndependentGeometric({
    successProbability,
    perAttemptCost,
    setupCost,
    saleValue: '0',
    budget: '0',
    withinAttempts: 1,
  });
  return { p50, p90, currency: input.currency };
}

export function compareCraftWithAsk(input: {
  basePrice: DecimalMoney | null;
  materialCost: DecimalMoney | null;
  expectedBases: number | null;
  ask: DecimalMoney | null;
  currency: string;
}) {
  const valid =
    input.basePrice?.currency === input.currency &&
    input.materialCost?.currency === input.currency &&
    input.expectedBases !== null;
  const cost =
    valid && input.basePrice && input.materialCost
      ? new Decimal(input.basePrice.amount)
          .mul(input.expectedBases ?? 1)
          .add(input.materialCost.amount)
      : null;
  const spread =
    cost && input.ask?.currency === input.currency
      ? new Decimal(input.ask.amount).sub(cost)
      : null;
  return {
    expectedCraftCost: cost?.toDecimalPlaces(8).toFixed() ?? null,
    profit: spread?.toDecimalPlaces(8).toFixed() ?? null,
    marginPercent:
      spread && cost?.gt(0)
        ? spread.div(cost).mul(100).toDecimalPlaces(8).toFixed()
        : null,
  };
}

/** Grades evidence after the sale and cost inputs pass validation. */
export function gradeSaleEvidence(input: {
  sellers: number;
  coverage: 'complete' | 'partial' | 'unknown';
  sortedSampleComplete: boolean;
  oldestInputAgeMs: number;
  freshnessWarningMs: number;
  ignoredOutliers: number;
}): { grade: 'A' | 'B' | 'C'; reasons: string[] } {
  const reasons: string[] = [];
  if (input.sellers === 1) reasons.push('1 seller');
  else if (input.sellers <= 4) reasons.push('2–4 sellers');
  if (input.coverage !== 'complete' && input.sortedSampleComplete)
    reasons.push('sorted sample, not full coverage');
  if (input.oldestInputAgeMs > input.freshnessWarningMs)
    reasons.push('inputs older than warning age');
  if (input.ignoredOutliers > 0) reasons.push('outlier ask ignored');
  return {
    grade: input.sellers === 1 ? 'C' : reasons.length > 0 ? 'B' : 'A',
    reasons,
  };
}
