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
  budgetModel?: CraftProcedure['budgetModel'];
}) {
  if (input.budgetModel) return independentStagesBudget(input);
  const probabilisticSteps = input.steps.filter(
    ({ success }) =>
      success && success.probability > 0 && success.probability < 1,
  );
  const [step] = probabilisticSteps;
  // Single geometric stage; two declared independent stages go through budgetModel above.
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

/**
 * Budget for two declared independent repeat-until-success stages on one base:
 * cost = setup + cA·GA + cB·GB with independent geometric GA, GB.
 * The distribution is summed directly (no sampling). The reported pXX is a
 * reachable cost x with P(cost ≤ x) ≥ XX% − 1e-9; the mean stays the entered
 * expected craft cost. Returns null rather than guessing when an input is missing.
 */
function independentStagesBudget(
  input: Parameters<typeof singleItemCraftBudget>[0],
) {
  if (!input.budgetModel || input.expectedCraftCost === null) return null;
  const { stepIds } = input.budgetModel;
  let setup = new DecimalValue(input.expectedCraftCost);
  const stages: { p: number; cost: Decimal; p75: number; p95: number }[] = [];
  for (const step of input.steps) {
    const probability = step.success?.probability;
    if (!stepIds.includes(step.id)) {
      // Same rule as the schema: nothing uncertain may sit outside the declared stages.
      if (
        probability === undefined ? step.materials.length > 0 : probability < 1
      )
        return null;
      continue;
    }
    const execution = input.expectedExecutions?.find(
      ({ stepId }) => stepId === step.id,
    );
    if (probability === undefined || probability >= 1 || !execution)
      return null;
    let cost = new DecimalValue(0);
    for (const { unitPrice, quantityPerAttempt } of step.materials) {
      if (!unitPrice || quantityPerAttempt === null) return null;
      cost = cost.add(
        new DecimalValue(unitPrice.amount).mul(quantityPerAttempt),
      );
    }
    const successProbability = new DecimalValue(probability)
      .toSignificantDigits(12)
      .toFixed();
    const perAttemptCost = cost.toDecimalPlaces(16).toFixed();
    if (
      !cost.gt(0) ||
      ![successProbability, perAttemptCost].every(isOutcomeAmount)
    )
      return null;
    // Per-stage p75 / p95 bound the sum's p50 / p90 (union bound on the two tails).
    const { p75, p95 } = analyzeIndependentGeometric({
      successProbability,
      perAttemptCost,
      setupCost: '0',
      saleValue: '0',
      budget: '0',
      withinAttempts: 1,
    }).costQuantiles;
    setup = setup.sub(cost.mul(execution.count));
    stages.push({
      p: Number(successProbability),
      cost,
      p75: Number(p75),
      p95: Number(p95),
    });
  }
  setup = setup.toDecimalPlaces(8);
  if (stages.length !== 2 || setup.lt(0)) return null;

  // Enumerate attempts of the likelier stage; the other stage has a closed-form CDF.
  const [few, many] = [...stages].sort((a, b) => b.p - a.p) as [
    (typeof stages)[number],
    (typeof stages)[number],
  ];
  const terms = Math.ceil(Math.log(1e-12) / Math.log1p(-few.p));
  // shortcut: 20k-term cap; revisit when both stage probabilities are below 0.14%.
  if (!(terms >= 1 && terms <= 20_000)) return null;
  const fewCost = few.cost.toNumber();
  const manyCost = many.cost.toNumber();
  const weights = Array.from(
    { length: terms },
    (_, index) => few.p * (1 - few.p) ** index,
  );
  const logFailure = Math.log1p(-many.p);
  const attemptsWithin = (x: number, fewAttempts: number) =>
    Math.floor((x - fewCost * fewAttempts) / manyCost + 1e-9);
  const cdf = (x: number) => {
    let total = 0;
    for (let b = 1; b <= terms; b++) {
      const n = attemptsWithin(x, b);
      if (n < 1) break;
      total += weights[b - 1]! * -Math.expm1(n * logFailure);
    }
    return total;
  };
  const quantile = (q: number, upper: number) => {
    const target = q - 1e-9;
    let low = fewCost + manyCost;
    let high = upper;
    if (!(cdf(high) >= target)) return null;
    if (cdf(low) >= target) high = low;
    else
      for (let i = 0; i < 64; i++) {
        const middle = (low + high) / 2;
        if (cdf(middle) >= target) high = middle;
        else low = middle;
      }
    // The quantile is a reachable cost; snap to the nearest one and price it exactly.
    let best = { distance: Infinity, b: 1, n: 1 };
    for (let b = 1; b <= terms; b++) {
      const n = Math.round((high - fewCost * b) / manyCost);
      if (n < 1) break;
      const distance = Math.abs(fewCost * b + manyCost * n - high);
      if (distance < best.distance) best = { distance, b, n };
    }
    return setup
      .add(few.cost.mul(best.b))
      .add(many.cost.mul(best.n))
      .toDecimalPlaces(8)
      .toFixed();
  };
  const p50 = quantile(0.5, few.p75 + many.p75);
  const p90 = quantile(0.9, few.p95 + many.p95);
  return p50 === null || p90 === null
    ? null
    : { p50, p90, currency: input.currency };
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
