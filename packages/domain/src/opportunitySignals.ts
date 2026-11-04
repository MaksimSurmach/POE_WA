import { Decimal } from 'decimal.js';
import { analyzeOutcomeModel } from './outcomeEconomics.js';
import {
  intelligenceVersion,
  intelligenceSettingsSchema,
  opportunityEvidenceSchema,
  opportunitySignalSchema,
  type IntelligenceSettings,
  type OpportunityEvidence,
  type OpportunitySignal,
  type IntelligenceRiskOption,
  type LiquidityAssessment,
} from './intelligence.js';
import type { OutcomeAnalysisInput } from './outcomeModel.js';
const D = Decimal.clone({ precision: 80 });
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
/** Evidence dates may change without changing the distribution; both snapshots still require independent freshness validation. */
export function intelligenceMonetaryFingerprint(
  input: OutcomeAnalysisInput,
): string {
  return JSON.stringify(
    canonical({
      model: input.model,
      currency: input.currency,
      league: input.league,
      prices: Object.fromEntries(
        Object.entries(input.prices).map(([k, v]) => [
          k,
          { amount: v.amount, currency: v.currency },
        ]),
      ),
      valuations: Object.fromEntries(
        Object.entries(input.valuations).map(([k, v]) => [
          k,
          {
            min: v.min,
            max: v.max,
            currency: v.currency,
            matching: v.matching,
          },
        ]),
      ),
    }),
  );
}
const validNumber = (v: string | null, signed = false) =>
  v !== null &&
  v.length <= 100 &&
  new RegExp(signed ? '^-?\\d+(?:\\.\\d+)?$' : '^\\d+(?:\\.\\d+)?$').test(v) &&
  new D(v).abs().lte('1e40');
export function intelligenceRiskIssues(
  option: IntelligenceRiskOption,
  current: OutcomeAnalysisInput,
  identity: {
    recipeId: string;
    recipeHash: string;
    targetSignature: string;
    league: string;
  },
  now: string,
): string[] {
  const issues: string[] = [];
  if (
    option.recipeId !== identity.recipeId ||
    option.recipeHash !== identity.recipeHash ||
    option.targetSignature !== identity.targetSignature ||
    option.league !== identity.league ||
    current.league !== identity.league
  )
    issues.push(
      'Risk option belongs to a different recipe, revision, target or league',
    );
  if (Date.parse(option.createdAt) > Date.parse(now))
    issues.push('Risk result is dated in the future');
  if (option.result.status !== 'complete' || option.result.censoredTrials !== 0)
    issues.push('Risk simulation is incomplete or censored');
  if (option.result.currency !== 'chaos' || current.currency !== 'chaos')
    issues.push('Risk calculations must use chaos accounting');
  if (
    JSON.stringify(option.result.objective) !==
    JSON.stringify(option.request.objective)
  )
    issues.push('Risk objective does not match its saved request');
  if (
    intelligenceMonetaryFingerprint(option.request.analysis) !==
    intelligenceMonetaryFingerprint(current)
  )
    issues.push('Prices or model changed after the risk simulation');
  if (
    analyzeOutcomeModel({ ...option.request.analysis, now }).status !==
      'complete' ||
    analyzeOutcomeModel({ ...current, now }).status !== 'complete'
  )
    issues.push('Saved or current economic evidence is incomplete or stale');
  if (
    !validNumber(option.result.meanProfit, true) ||
    !validNumber(option.result.meanCost) ||
    !validNumber(option.result.costQuantiles?.p90 ?? null) ||
    !validNumber(option.result.costQuantiles?.p95 ?? null) ||
    option.result.probabilityOfLoss === null
  )
    issues.push('Required numerical risk outputs are unavailable');
  const analysis = analyzeOutcomeModel(current);
  const targets = current.model.stages.flatMap((s) =>
    s.outcomes.filter((o) => o.targetSuccess),
  );
  if (
    analysis.unvaluedRetainedBaseProbability !== '0' &&
    (option.result.objective.kind === 'attempts' ||
      targets.length === 0 ||
      targets.some((o) => !o.sellable || o.baseDisposition !== 'consumed'))
  )
    issues.push('The selected objective leaves unvalued retained assets');
  return issues;
}
export function saleableCohortIssues(
  input: OutcomeAnalysisInput,
  liquidities: LiquidityAssessment[],
): string[] {
  const issues: string[] = [];
  for (const outcome of input.model.stages
    .flatMap((s) => s.outcomes)
    .filter((o) => o.sellable && o.probability.value !== '0')) {
    if (outcome.matching.kind !== 'exact-target') {
      issues.push(
        `Saleable outcome ${outcome.id} lacks an exact market cohort`,
      );
      continue;
    }
    const signature = outcome.matching.targetSignature;
    const found = liquidities.find(
      (l) =>
        l.cohort.targetSignature === signature &&
        l.cohort.league === input.league,
    );
    const quote = input.valuations[outcome.id];
    if (
      !quote ||
      quote.provenance.kind !== 'market-observation' ||
      !quote.market ||
      quote.market.coverage !== 'complete' ||
      (quote.market.independentSellers ?? 0) < 2
    )
      issues.push(
        `Saleable outcome ${outcome.id} needs a supported current market quotation; manual assumptions and individual transactions are not production quotes`,
      );
    else if (
      found &&
      (!found.evidenceIds.some(
        (id) =>
          quote.provenance.reference === id ||
          quote.provenance.reference.endsWith(`:${id}`),
      ) ||
        !found.asking ||
        new D(quote.max).gt(found.asking.median))
    )
      issues.push(
        `Saleable outcome ${outcome.id} valuation is not supported by the current comparable snapshot evidence and median asking price`,
      );
    if (!found || found.status !== 'supported')
      issues.push(
        `Saleable outcome ${outcome.id} has insufficient liquidity evidence`,
      );
  }
  return [...new Set(issues)];
}
/** Historical confirmations cannot authorize a different owner policy. Malformed old state fails closed. */
export function signalPolicyMatches(
  signal: OpportunitySignal,
  settings: IntelligenceSettings,
): boolean {
  try {
    const basis = JSON.parse(signal.confirmationBasis) as {
      settings?: unknown;
    };
    return (
      JSON.stringify(canonical(basis.settings)) ===
      JSON.stringify(canonical(settings))
    );
  } catch {
    return false;
  }
}
export function signalConfirmsRiskOption(
  signal: OpportunitySignal,
  settings: IntelligenceSettings,
  riskId: string,
): boolean {
  if (
    signal.state !== 'CRAFT' ||
    !signal.hysteresisArmed ||
    !signalPolicyMatches(signal, settings)
  )
    return false;
  try {
    return (
      (JSON.parse(signal.confirmationBasis) as { riskId?: unknown }).riskId ===
      riskId
    );
  } catch {
    return false;
  }
}
export function stepOpportunitySignal(raw: {
  previous: OpportunitySignal | null;
  evidence: OpportunityEvidence;
  settings: IntelligenceSettings;
  now: string;
}): OpportunitySignal {
  const e = opportunityEvidenceSchema.parse(raw.evidence),
    settings = intelligenceSettingsSchema.parse(raw.settings),
    now = raw.now;
  const previous = raw.previous
    ? opportunitySignalSchema.parse(raw.previous)
    : null;
  const confirmationBasis = JSON.stringify({
    riskId: e.risk?.id ?? null,
    settings,
  });
  const prior =
    previous?.recipeHash === e.recipeHash &&
    previous.cohort.league === e.cohort.league &&
    previous.cohort.targetSignature === e.cohort.targetSignature
      ? previous
      : null;
  const hysteresisArmed =
    prior?.hysteresisArmed === true && signalPolicyMatches(prior, settings);
  const confirmationPrior =
    prior?.confirmationBasis === confirmationBasis ? prior : null;
  const reasons: string[] = [],
    triggers: string[] = [];
  const risk = e.risk?.result;
  const analysis = e.analysisInput
    ? analyzeOutcomeModel({ ...e.analysisInput, now })
    : null;
  if (
    e.observationId !== e.liquidity.snapshotId ||
    e.observedAt !== e.liquidity.observedAt ||
    e.cohort.league !== e.liquidity.cohort.league ||
    e.cohort.targetSignature !== e.liquidity.cohort.targetSignature
  )
    reasons.push('Observation identity does not match the exact market cohort');
  if (!e.analysisInput || analysis?.status !== 'complete')
    reasons.push(
      'EV unavailable: probabilities or economic evidence are missing',
    );
  if (
    e.liquidity.status !== 'supported' ||
    !e.liquidity.expiresAt ||
    Date.parse(e.liquidity.expiresAt) <= Date.parse(now)
  )
    reasons.push('Market evidence is incomplete or stale');
  if (e.liquidity.sellers < settings.minIndependentSellers)
    reasons.push('Independent seller requirement is not met');
  if (e.liquidity.independentObservations < settings.minConfirmations)
    reasons.push('Multiple fresh independent market observations are required');
  if (e.risk && e.analysisInput)
    reasons.push(
      ...intelligenceRiskIssues(
        e.risk,
        e.analysisInput,
        {
          recipeId: e.recipeId,
          recipeHash: e.recipeHash,
          targetSignature: e.cohort.targetSignature,
          league: e.cohort.league,
        },
        now,
      ),
    );
  else reasons.push('A matching completed risk simulation is required');
  if (e.analysisInput)
    reasons.push(
      ...saleableCohortIssues(e.analysisInput, [
        e.liquidity,
        ...e.additionalLiquidities,
      ]),
    );
  let candidate: OpportunitySignal['state'] = 'INSUFFICIENT_DATA';
  const profit = validNumber(risk?.meanProfit ?? null, true)
    ? risk!.meanProfit
    : null;
  const bankroll = validNumber(risk?.costQuantiles?.p95 ?? null)
    ? risk!.costQuantiles!.p95
    : null;
  const roi =
    profit !== null && bankroll !== null && new D(bankroll).gt(0)
      ? new D(profit).div(bankroll).mul(100).toDecimalPlaces(8).toFixed()
      : null;
  if (!reasons.length && profit !== null) {
    if (new D(profit).lt(0)) {
      candidate = 'STOP';
      if (
        prior?.state !== 'STOP' ||
        prior.metrics.profit === null ||
        !new D(prior.metrics.profit).eq(profit)
      )
        triggers.push('NEGATIVE_EV');
    } else {
      const threshold = hysteresisArmed
        ? settings.exitProfitChaos
        : settings.enterProfitChaos;
      const roiThreshold = hysteresisArmed
        ? settings.exitRiskAdjustedRoiPercent
        : settings.enterRiskAdjustedRoiPercent;
      candidate =
        new D(profit).gte(threshold) &&
        roi !== null &&
        new D(roi).gte(roiThreshold) &&
        (risk?.probabilityOfLoss ?? 1) <= settings.maxLossProbability &&
        (e.liquidity.largestSellerShare ?? 1) <= settings.maxSellerShare
          ? 'CRAFT'
          : 'WATCH';
      if (candidate === 'WATCH')
        reasons.push(
          'Economics, loss risk or seller concentration is near or outside configured production thresholds',
        );
    }
  }
  if (analysis?.status === 'complete' && analysis.basis !== 'observations')
    reasons.push(
      'Crafting probabilities or input costs include explicitly labelled model assumptions',
    );
  const metric = {
    profit,
    materialCost: analysis?.expectedCosts?.material ?? null,
    ask: e.liquidity.asking?.median ?? null,
    sellers: e.liquidity.sellers,
    listings: e.liquidity.listings,
    riskAdjustedRoiPercent: roi,
  };
  const moved = (
    before: string | null,
    after: string | null,
    threshold: string,
  ) =>
    before !== null &&
    after !== null &&
    new D(before).abs().gt(0) &&
    !new D(after).eq(before) &&
    new D(after)
      .sub(before)
      .div(new D(before).abs())
      .mul(100)
      .abs()
      .gte(threshold);
  if (prior) {
    if (prior.confirmationBasis !== confirmationBasis)
      triggers.push('MODEL_OR_POLICY_CHANGED');
    if (
      prior.metrics.profit !== null &&
      profit !== null &&
      new D(prior.metrics.profit).lt(settings.enterProfitChaos) &&
      new D(profit).gte(settings.enterProfitChaos)
    )
      triggers.push('PROFIT_THRESHOLD_CROSSED');
    if (
      moved(
        prior.metrics.materialCost,
        metric.materialCost,
        settings.materialMovePercent,
      )
    )
      triggers.push('MATERIAL_PRICE_CHANGED');
    if (moved(prior.metrics.ask, metric.ask, settings.askMovePercent))
      triggers.push('ASKING_PRICE_CHANGED');
    if (
      moved(
        String(prior.metrics.sellers),
        String(metric.sellers),
        settings.sellerMovePercent,
      )
    )
      triggers.push('SELLER_COUNT_CHANGED');
    if (
      prior.metrics.listings > 0 &&
      metric.listings > prior.metrics.listings &&
      new D(metric.listings - prior.metrics.listings)
        .div(prior.metrics.listings)
        .mul(100)
        .gte(settings.supplyGrowthPercent)
    ) {
      triggers.push('SUPPLY_GROWTH');
      if (candidate === 'CRAFT') {
        candidate = 'WATCH';
        reasons.push(
          'Observed listing supply grew above the configured threshold',
        );
      }
    }
    if (
      prior.state === 'INSUFFICIENT_DATA' &&
      candidate !== 'INSUFFICIENT_DATA'
    )
      triggers.push('EVIDENCE_BECAME_SUPPORTED');
  }
  const independent =
    e.observationId !== null &&
    e.observedAt !== null &&
    (!prior?.lastObservationId ||
      (e.observationId !== prior.lastObservationId &&
        Date.parse(e.observedAt) -
          Date.parse(prior.lastObservedAt ?? e.observedAt) >=
          settings.minObservationGapSeconds * 1000));
  const confirmations =
    candidate === 'CRAFT'
      ? confirmationPrior?.candidate === 'CRAFT'
        ? confirmationPrior.confirmations + (independent ? 1 : 0)
        : 1
      : 0;
  const state =
    candidate === 'CRAFT' && confirmations < settings.minConfirmations
      ? 'WATCH'
      : candidate;
  if (candidate === 'CRAFT' && state === 'WATCH')
    reasons.push(
      `Waiting for ${settings.minConfirmations} distinct qualifying observations`,
    );
  if (prior?.state !== state) triggers.push(`STATE_${state}`);
  if (state === 'CRAFT') triggers.push('RISK_ADJUSTED_THRESHOLD_MET');
  const changed =
    !prior ||
    prior.state !== state ||
    triggers.some((t) => !['RISK_ADJUSTED_THRESHOLD_MET'].includes(t));
  const cooled =
    !prior?.lastEmittedAt ||
    Date.parse(now) - Date.parse(prior.lastEmittedAt) >=
      settings.cooldownSeconds * 1000;
  const emit = changed && cooled;
  return opportunitySignalSchema.parse({
    version: intelligenceVersion,
    recipeId: e.recipeId,
    recipeHash: e.recipeHash,
    cohort: e.cohort,
    state,
    candidate,
    confirmations,
    hysteresisArmed:
      state === 'CRAFT' || (hysteresisArmed && candidate === 'CRAFT'),
    confirmationBasis,
    lastObservationId: independent
      ? e.observationId
      : (prior?.lastObservationId ?? e.observationId),
    lastObservedAt: independent
      ? e.observedAt
      : (prior?.lastObservedAt ?? e.observedAt),
    lastEmittedAt: emit ? now : (prior?.lastEmittedAt ?? null),
    evaluatedAt: now,
    emit,
    triggers: [...new Set(triggers)],
    reasons: [...new Set(reasons)],
    evidenceIds: [
      ...new Set([
        ...e.liquidity.evidenceIds,
        ...e.additionalLiquidities.flatMap((l) => l.evidenceIds),
        ...(e.risk ? [e.risk.id] : []),
      ]),
    ],
    metrics: metric,
  });
}
