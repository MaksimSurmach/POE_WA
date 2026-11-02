import { Decimal } from 'decimal.js';

import type { CanonicalCraftVariant } from './recipeSchemaV2.js';

/** Returns entered expected material usage per finished item, or null if unknown. */
export function expectedVariantMaterialUsage(
  variant: CanonicalCraftVariant,
): Record<string, number> | null {
  const executions = new Map(
    variant.expectedExecutions?.map(({ count, stepId }) => [stepId, count]),
  );
  const quantities = new Map<string, number>();

  for (const step of variant.steps) {
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

export function calculateVariantMaterialEconomics(input: {
  currency: string;
  materialPrices: Readonly<
    Record<string, { amount: string; currency: string } | null | undefined>
  >;
  variant: CanonicalCraftVariant;
}) {
  const DecimalValue = Decimal.clone({
    precision: 40,
    rounding: Decimal.ROUND_HALF_UP,
  });
  const expectedExecutions = new Map(
    input.variant.expectedExecutions?.map(({ count, stepId }) => [
      stepId,
      count,
    ]),
  );
  let expectedCost = new DecimalValue(0);
  let expectedCostAvailable = true;
  const stepAttemptCosts: (Decimal | null)[] = [];
  const steps = input.variant.steps.map((step) => {
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
  const hasOneStep = input.variant.steps.length === 1;
  const oneStepCost = hasOneStep ? (stepAttemptCosts[0] ?? null) : null;
  return {
    expectedCost:
      expectedCostAvailable && input.variant.expectedExecutions
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
