import { Decimal } from 'decimal.js';
import { z } from 'zod';
import {
  outcomeAnalysisInputSchema,
  isOutcomeAmount,
  outcomeCalculationVersion,
  type OutcomeAnalysisInput,
  type OutcomeCost,
  type OutcomePriceQuote,
  type OutcomeValueQuote,
  type OutcomeProvenance,
} from './outcomeModel.js';

const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
const money = z.string();
export const outcomeRangeSchema = z.strictObject({ min: money, max: money });
export type OutcomeRange = z.infer<typeof outcomeRangeSchema>;
const costBreakdownSchema = z.strictObject({
  base: money,
  material: money,
  finishing: money,
  recovery: money,
});
export const outcomeAnalysisSchema = z.strictObject({
  calculationVersion: z.literal(outcomeCalculationVersion),
  horizon: z.literal('one-method-run-with-setup'),
  status: z.enum(['complete', 'unavailable']),
  reasons: z.array(z.string()),
  basis: z.enum(['assumptions', 'observations', 'mixed']),
  currency: z.string(),
  expectedCosts: costBreakdownSchema.nullable(),
  expectedTotalCost: money.nullable(),
  // Gross base inputs acquired for one method run; a retained base can remain in inventory.
  expectedBaseAcquisition: money.nullable(),
  expectedGrossResale: outcomeRangeSchema.nullable(),
  expectedSalvageRecovery: outcomeRangeSchema.nullable(),
  expectedRecoveryCredit: money.nullable(),
  expectedNetProfit: outcomeRangeSchema.nullable(),
  expectedRoiPercent: outcomeRangeSchema.nullable(),
  targetProbability: money.nullable(),
  expectedSaleableItems: money.nullable(),
  breakEvenOutputPrice: outcomeRangeSchema.nullable(),
  breakEvenMaterialCost: outcomeRangeSchema.nullable(),
  sensitivity: z.array(
    z.strictObject({
      label: z.string(),
      materialPriceMultiplier: money,
      sellingPriceMultiplier: money,
      netProfit: outcomeRangeSchema,
    }),
  ),
  stageValues: z.array(
    z.strictObject({
      stageId: z.string(),
      cost: money,
      netProfit: outcomeRangeSchema,
    }),
  ),
});
export type OutcomeAnalysis = z.infer<typeof outcomeAnalysisSchema>;
export function outcomeMoney(value: Decimal.Value): string {
  return new D(value).toDecimalPlaces(8).toFixed();
}
const range = (min: Decimal.Value, max: Decimal.Value): OutcomeRange => ({
  min: outcomeMoney(min),
  max: outcomeMoney(max),
});

function evidenceIssues(
  source: OutcomeProvenance,
  now: number,
  label: string,
): string[] {
  return Date.parse(source.recordedAt) > now
    ? [`${label}: provenance is dated in the future`]
    : [];
}
function quoteIssues(
  quote: OutcomePriceQuote | OutcomeValueQuote,
  input: OutcomeAnalysisInput,
  label: string,
  resale: boolean,
): string[] {
  const issues = evidenceIssues(quote.provenance, Date.parse(input.now), label);
  if (quote.currency !== input.currency)
    issues.push(`${label}: currency does not match analysis currency`);
  if (quote.provenance.kind === 'market-observation') {
    const m = quote.market;
    if (!m) issues.push(`${label}: missing market provenance`);
    else {
      const now = Date.parse(input.now);
      if (m.league !== input.league)
        issues.push(`${label}: market observation belongs to another league`);
      if (
        Date.parse(m.observedAt) > now ||
        Date.parse(m.expiresAt) <= now ||
        Date.parse(m.expiresAt) <= Date.parse(m.observedAt)
      )
        issues.push(`${label}: market observation is stale or invalid`);
      if (resale && m.independentSellers < 2)
        issues.push(`${label}: insufficient independent sellers`);
      if (resale && m.coverage !== 'complete')
        issues.push(`${label}: incomplete resale market coverage`);
    }
  }
  return issues;
}

export function reachableOutcomeStages(input: OutcomeAnalysisInput) {
  const ids = new Set<string>();
  const pending = [input.model.startStageId];
  while (pending.length) {
    const id = pending.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    const stage = input.model.stages.find((s) => s.id === id)!;
    for (const outcome of stage.outcomes)
      if (
        outcome.nextStageId !== null &&
        (outcome.probability.value === null ||
          new D(outcome.probability.value).gt(0))
      )
        pending.push(outcome.nextStageId);
  }
  return input.model.stages.filter((s) => ids.has(s.id));
}

/** Completeness applies to reachable positive-probability paths, never to a fabricated residual. */
export function outcomeInputIssues(input: OutcomeAnalysisInput): string[] {
  const issues = [...input.model.unknowns];
  for (const stage of reachableOutcomeStages(input)) {
    issues.push(
      ...evidenceIssues(
        stage.exclusivity.provenance,
        Date.parse(input.now),
        stage.id,
      ),
    );
    const costs: OutcomeCost[] = [
      ...stage.costs,
      ...(stage.id === input.model.startStageId
        ? input.model.initialCosts
        : []),
    ];
    for (const outcome of stage.outcomes) {
      if (outcome.probability.value === null) {
        issues.push(`${outcome.id}: missing outcome probability`);
        continue;
      }
      if (outcome.probability.provenance)
        issues.push(
          ...evidenceIssues(
            outcome.probability.provenance,
            Date.parse(input.now),
            outcome.id,
          ),
        );
      if (new D(outcome.probability.value).eq(0)) continue;
      issues.push(...outcome.unknowns.map((s) => `${outcome.id}: ${s}`));
      costs.push(
        ...outcome.costs,
        ...outcome.credits.map((c) => ({ ...c, kind: 'recovery' as const })),
      );
      if (outcome.sellable) {
        const quote = input.valuations[outcome.id];
        if (!quote) issues.push(`${outcome.id}: missing resale value`);
        else {
          issues.push(...quoteIssues(quote, input, outcome.id, true));
          if (
            outcome.matching.kind !== quote.matching.kind ||
            (outcome.matching.kind === 'manual' &&
              quote.matching.kind === 'manual' &&
              outcome.matching.description !== quote.matching.description) ||
            (outcome.matching.kind === 'exact-target' &&
              (quote.matching.kind !== 'exact-target' ||
                quote.matching.targetSignature !==
                  outcome.matching.targetSignature))
          )
            issues.push(
              `${outcome.id}: resale value does not match outcome target`,
            );
          if (
            outcome.matching.kind === 'manual' &&
            quote.provenance.kind === 'market-observation'
          )
            issues.push(
              `${outcome.id}: market valuation needs an exact target signature`,
            );
        }
      }
    }
    for (const cost of costs) {
      issues.push(
        ...evidenceIssues(
          cost.provenance,
          Date.parse(input.now),
          cost.resourceId,
        ),
      );
      if (cost.quantity === null) {
        issues.push(
          `${stage.id}/${cost.resourceId}: missing material quantity`,
        );
        continue;
      }
      if (new D(cost.quantity).eq(0)) continue;
      const quote = input.prices[cost.resourceId];
      if (!quote) issues.push(`${cost.resourceId}: missing purchase price`);
      else issues.push(...quoteIssues(quote, input, cost.resourceId, false));
    }
  }
  return [...new Set(issues)];
}

const rewardNames = [
  'base',
  'material',
  'finishing',
  'recovery',
  'baseUnits',
  'resaleMin',
  'resaleMax',
  'salvageMin',
  'salvageMax',
  'credits',
  'target',
  'saleable',
  'absorption',
  'targetRevenueMin',
  'targetRevenueMax',
] as const;
type Reward = (typeof rewardNames)[number];
const rewardIndex = Object.fromEntries(
  rewardNames.map((name, index) => [name, index]),
) as Record<Reward, number>;

function expectedStageRewards(input: OutcomeAnalysisInput) {
  const stages = reachableOutcomeStages(input);
  const indices = new Map(stages.map((s, i) => [s.id, i]));
  const n = stages.length;
  const matrix = stages.map((stage, row) => {
    const coefficients = Array.from(
      { length: n },
      (_, column) => new D(row === column ? 1 : 0),
    );
    const rewards = rewardNames.map(() => new D(0));
    const add = (kind: Reward, amount: Decimal.Value) => {
      rewards[rewardIndex[kind]] = rewards[rewardIndex[kind]]!.add(amount);
    };
    const addCost = (cost: OutcomeCost, weight: Decimal) => {
      const quantity = new D(cost.quantity!);
      if (quantity.eq(0)) return;
      add(
        cost.kind,
        quantity.mul(input.prices[cost.resourceId]!.amount).mul(weight),
      );
      if (cost.kind === 'base') add('baseUnits', quantity.mul(weight));
    };
    for (const cost of stage.costs) addCost(cost, new D(1));
    for (const outcome of stage.outcomes) {
      const p = new D(outcome.probability.value!);
      if (p.eq(0)) continue;
      for (const cost of outcome.costs) addCost(cost, p);
      for (const credit of outcome.credits)
        if (new D(credit.quantity!).gt(0))
          add(
            'credits',
            p
              .mul(credit.quantity!)
              .mul(input.prices[credit.resourceId]!.amount),
          );
      if (outcome.nextStageId !== null) {
        const column = indices.get(outcome.nextStageId)!;
        coefficients[column] = coefficients[column]!.sub(p);
      } else {
        add('absorption', p);
        if (outcome.targetSuccess) add('target', p);
        if (outcome.sellable) {
          const value = input.valuations[outcome.id]!;
          add('saleable', p);
          add('resaleMin', p.mul(value.min));
          add('resaleMax', p.mul(value.max));
          if (outcome.classification === 'salvage') {
            add('salvageMin', p.mul(value.min));
            add('salvageMax', p.mul(value.max));
          }
          if (outcome.targetSuccess) {
            add('targetRevenueMin', p.mul(value.min));
            add('targetRevenueMax', p.mul(value.max));
          }
        }
      }
    }
    return [...coefficients, ...rewards];
  });
  // Solve (I - Q)V = R for all reward channels together; retries are not treated as independent whole crafts.
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++)
      if (matrix[row]![column]!.abs().gt(matrix[pivot]![column]!.abs()))
        pivot = row;
    if (matrix[pivot]![column]!.abs().lt('1e-35')) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!];
    const divisor = matrix[column]![column]!;
    matrix[column] = matrix[column]!.map((value) => value.div(divisor));
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = matrix[row]![column]!;
      matrix[row] = matrix[row]!.map((value, index) =>
        value.sub(factor.mul(matrix[column]![index]!)),
      );
    }
  }
  return stages.map((stage, index) => ({
    stageId: stage.id,
    rewards: Object.fromEntries(
      rewardNames.map((name, ri) => [name, matrix[index]![n + ri]!]),
    ) as Record<Reward, Decimal>,
  }));
}

export function analyzeOutcomeModel(
  raw: OutcomeAnalysisInput,
): OutcomeAnalysis {
  const input = outcomeAnalysisInputSchema.parse(raw);
  const sources = [
    ...input.model.initialCosts.map((c) => c.provenance),
    ...input.model.stages.flatMap((s) => [
      s.exclusivity.provenance,
      ...s.costs.map((c) => c.provenance),
      ...s.outcomes.flatMap((o) => [
        o.probability.provenance,
        ...o.costs.map((c) => c.provenance),
        ...o.credits.map((c) => c.provenance),
      ]),
    ]),
    ...Object.values(input.prices).map((p) => p.provenance),
    ...Object.values(input.valuations).map((p) => p.provenance),
  ].filter((s): s is OutcomeProvenance => s !== null);
  const assumed = sources.some((s) => s.kind === 'assumption');
  const observed = sources.some((s) =>
    ['market-observation', 'transaction'].includes(s.kind),
  );
  const result: OutcomeAnalysis = {
    calculationVersion: outcomeCalculationVersion,
    horizon: 'one-method-run-with-setup',
    status: 'unavailable',
    reasons: outcomeInputIssues(input),
    basis: assumed ? (observed ? 'mixed' : 'assumptions') : 'observations',
    currency: input.currency,
    expectedCosts: null,
    expectedTotalCost: null,
    expectedBaseAcquisition: null,
    expectedGrossResale: null,
    expectedSalvageRecovery: null,
    expectedRecoveryCredit: null,
    expectedNetProfit: null,
    expectedRoiPercent: null,
    targetProbability: null,
    expectedSaleableItems: null,
    breakEvenOutputPrice: null,
    breakEvenMaterialCost: null,
    sensitivity: [],
    stageValues: [],
  };
  if (result.reasons.length) return result;
  const solved = expectedStageRewards(input);
  if (
    !solved ||
    solved.some(
      ({ rewards: r }) =>
        r.absorption.sub(1).abs().gt('1e-25') ||
        Object.values(r).some(
          (v) => !v.isFinite() || v.abs().gt('1e24') || v.lt('-1e-25'),
        ),
    )
  ) {
    result.reasons = [
      'Outcome graph does not terminate with probability one, or exceeds supported numerical bounds',
    ];
    return result;
  }
  const r = {
    ...solved.find((s) => s.stageId === input.model.startStageId)!.rewards,
  };
  for (const cost of input.model.initialCosts) {
    const quantity = new D(cost.quantity!);
    if (quantity.eq(0)) continue;
    r[cost.kind] = r[cost.kind].add(
      quantity.mul(input.prices[cost.resourceId]!.amount),
    );
    if (cost.kind === 'base') r.baseUnits = r.baseUnits.add(quantity);
  }
  const total = r.base.add(r.material).add(r.finishing).add(r.recovery);
  const profitMin = r.resaleMin.add(r.credits).sub(total);
  const profitMax = r.resaleMax.add(r.credits).sub(total);
  const otherMin = r.resaleMin.sub(r.targetRevenueMin).add(r.credits);
  const otherMax = r.resaleMax.sub(r.targetRevenueMax).add(r.credits);
  return {
    ...result,
    status: 'complete',
    expectedCosts: {
      base: outcomeMoney(r.base),
      material: outcomeMoney(r.material),
      finishing: outcomeMoney(r.finishing),
      recovery: outcomeMoney(r.recovery),
    },
    expectedTotalCost: outcomeMoney(total),
    expectedBaseAcquisition: outcomeMoney(r.baseUnits),
    expectedGrossResale: range(r.resaleMin, r.resaleMax),
    expectedSalvageRecovery: range(r.salvageMin, r.salvageMax),
    expectedRecoveryCredit: outcomeMoney(r.credits),
    expectedNetProfit: range(profitMin, profitMax),
    expectedRoiPercent: total.gt(0)
      ? range(profitMin.div(total).mul(100), profitMax.div(total).mul(100))
      : null,
    targetProbability: r.target.toSignificantDigits(30).toFixed(),
    expectedSaleableItems: r.saleable.toSignificantDigits(30).toFixed(),
    breakEvenOutputPrice: r.target.gt(0)
      ? range(
          total.sub(otherMax).div(r.target),
          total.sub(otherMin).div(r.target),
        )
      : null,
    breakEvenMaterialCost: range(
      r.resaleMin.add(r.credits).sub(total.sub(r.material)),
      r.resaleMax.add(r.credits).sub(total.sub(r.material)),
    ),
    sensitivity: [
      ['Materials +10%', '1.1', '1'],
      ['Materials -10%', '0.9', '1'],
      ['Selling prices -10%', '1', '0.9'],
      ['Selling prices +10%', '1', '1.1'],
    ].map(([label, material, resale]) => ({
      label: label!,
      materialPriceMultiplier: material!,
      sellingPriceMultiplier: resale!,
      netProfit: range(
        r.resaleMin
          .mul(resale!)
          .add(r.credits)
          .sub(total)
          .sub(r.material.mul(new D(material!).sub(1))),
        r.resaleMax
          .mul(resale!)
          .add(r.credits)
          .sub(total)
          .sub(r.material.mul(new D(material!).sub(1))),
      ),
    })),
    stageValues: solved.map(({ stageId, rewards: s }) => {
      const cost = s.base.add(s.material).add(s.finishing).add(s.recovery);
      return {
        stageId,
        cost: outcomeMoney(cost),
        netProfit: range(
          s.resaleMin.add(s.credits).sub(cost),
          s.resaleMax.add(s.credits).sub(cost),
        ),
      };
    }),
  };
}

const signedActionAmount = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,16})?$/)
  .max(40)
  .refine((v) => isOutcomeAmount(v.startsWith('-') ? v.slice(1) : v));
const actionRangeSchema = z
  .strictObject({ min: signedActionAmount, max: signedActionAmount })
  .refine(
    (v) =>
      isOutcomeAmount(v.min.startsWith('-') ? v.min.slice(1) : v.min) &&
      isOutcomeAmount(v.max.startsWith('-') ? v.max.slice(1) : v.max) &&
      new D(v.min).lte(v.max),
    'Action value range is reversed',
  );
export const outcomeActionValuesSchema = z.strictObject({
  'keep-crafting': actionRangeSchema.nullable(),
  sell: actionRangeSchema.nullable(),
  recover: actionRangeSchema.nullable(),
  stop: actionRangeSchema.nullable(),
});
/** Inputs are incremental net proceeds from the current state; incurred costs are already sunk. */
export function recommendOutcomeAction(
  raw: z.infer<typeof outcomeActionValuesSchema>,
) {
  const parsed = outcomeActionValuesSchema.safeParse(raw);
  if (!parsed.success)
    return {
      action: null,
      reason: 'Decision unavailable — invalid action values',
    };
  const values = parsed.data;
  if (Object.values(values).some((v) => v === null))
    return {
      action: null,
      reason: 'Decision unavailable — missing action value or recovery costs',
    };
  const entries = Object.entries(values) as [
    keyof typeof values,
    OutcomeRange,
  ][];
  const winners = entries.filter(([action, value]) =>
    entries.every(
      ([other, alternative]) =>
        other === action || new D(value.min).gt(alternative.max),
    ),
  );
  return winners.length === 1
    ? {
        action: winners[0]![0],
        reason: 'Conservative net proceeds exceed every alternative',
      }
    : {
        action: null,
        reason: 'Decision unavailable — action value ranges overlap',
      };
}
