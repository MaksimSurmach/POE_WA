import type {
  MarketResearchSnapshot,
  MarketTarget,
  BeltPriceUpdate,
} from '@poe-worksmith/contracts';
import {
  aggregateMarketListings,
  DomainError,
  type MarketListing,
} from '@poe-worksmith/domain';
import { calculateRecipeEconomics } from '@poe-worksmith/domain/economics';
import { analyzeBeltSnapshot } from './beltComparability.js';
import type { MarketEconomyRepository } from './marketEconomy.js';
import { convertMarketQuote } from './marketCurrency.js';
import { generateMarketTradeQuery } from './marketTradeQuery.js';

type Method = NonNullable<MarketTarget['beltCraftMethod']>;
type Price = Method['basePrice'];
const DAY = 24 * 60 * 60 * 1000;

/** Resolve only explicitly selected evidence; never substitute an aggregate base for a rare item. */
async function resolvePrice(input: {
  evidence: Price;
  label: string;
  target: MarketTarget;
  snapshot: MarketResearchSnapshot;
  economy?: Pick<MarketEconomyRepository, 'find'> | undefined;
  base: boolean;
  now: number;
}) {
  const { evidence, target, snapshot } = input;
  if (evidence.source === 'manual') {
    if (
      evidence.league !== target.league ||
      evidence.patch !== target.patch ||
      evidence.dataKind !== snapshot.dataKind
    )
      return null;
    const age = input.now - Date.parse(evidence.capturedAt);
    if (
      age < 0 ||
      age > DAY ||
      Math.abs(
        Date.parse(snapshot.capturedAt) - Date.parse(evidence.capturedAt),
      ) > DAY
    )
      return null;
    const converted = await convertMarketQuote({
      money: { amount: String(evidence.amount), currency: evidence.currency },
      currency: snapshot.currency,
      target,
      capturedAt: snapshot.capturedAt,
      now: input.now,
      dataKind: snapshot.dataKind,
      ...(input.economy ? { economy: input.economy } : {}),
      ...(evidence.exchangeSnapshotId
        ? { exchangeSnapshotId: evidence.exchangeSnapshotId }
        : {}),
    });
    return converted
      ? {
          money: converted.money,
          evidence: {
            ...evidence,
            ...(converted.exchange ? { exchange: converted.exchange } : {}),
          },
        }
      : null;
  }
  // BaseType is an aggregate and cannot prove item level or influences.
  if (
    input.base ||
    snapshot.dataKind !== 'observed' ||
    evidence.patch !== target.patch ||
    !input.economy
  )
    return null;
  const stored = await input.economy.find(evidence.snapshotId);
  if (
    !stored ||
    stored.league !== target.league ||
    !['Currency', 'Essence', 'Fossil', 'Resonator'].includes(stored.category)
  )
    return null;
  const age = input.now - Date.parse(stored.capturedAt);
  if (
    age < 0 ||
    age > DAY ||
    Math.abs(Date.parse(snapshot.capturedAt) - Date.parse(stored.capturedAt)) >
      DAY
  )
    return null;
  const line = stored.lines.find(
    (candidate) => candidate.id === evidence.lineId,
  );
  if (!line || line.name !== input.label || !line.price.amount) return null;
  const converted = await convertMarketQuote({
    money: { amount: String(line.price.amount), currency: line.price.currency },
    currency: snapshot.currency,
    target,
    capturedAt: snapshot.capturedAt,
    now: input.now,
    dataKind: snapshot.dataKind,
    economy: input.economy,
    ...(evidence.exchangeSnapshotId
      ? { exchangeSnapshotId: evidence.exchangeSnapshotId }
      : {}),
  });
  if (!converted) return null;
  return {
    money: converted.money,
    evidence: {
      ...evidence,
      url: stored.endpoint,
      capturedAt: stored.capturedAt,
      league: stored.league,
      category: stored.category,
      name: line.name,
      amount: line.price.amount,
      currency: line.price.currency,
      ...(converted.exchange ? { exchange: converted.exchange } : {}),
    },
  };
}

export async function evaluateBeltOpportunity(
  target: MarketTarget,
  snapshot: MarketResearchSnapshot | null,
  economy?: Pick<MarketEconomyRepository, 'find'>,
  now = Date.now(),
  priceUpdate?: BeltPriceUpdate,
) {
  const reasons: string[] = [];
  const method = target.beltCraftMethod;
  if (!target.sources.length) reasons.push('Build source is missing.');
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(target.patch))
    reasons.push('Patch must identify a numeric game version for the recipe.');
  if (!target.beltRules && !target.tradeSearch)
    reasons.push('Executable target rules are missing.');
  if (!method)
    reasons.push(
      'Craft cost model, expected attempts and dated prices are missing.',
    );
  if (method && !method.rulesComplete)
    reasons.push('Rules are not confirmed to cover the build requirements.');
  if (!snapshot) reasons.push('No imported rare listing observation.');
  const comparison = snapshot
    ? analyzeBeltSnapshot(target, snapshot, now)
    : null;
  if (comparison && !comparison.conservativeAskingPrice)
    reasons.push(
      'Need a fresh sample of at least five independent confirmed sellers.',
    );
  let queryUrl: string | null = null;
  try {
    queryUrl = target.tradeSearch
      ? generateMarketTradeQuery(target).url
      : snapshot?.sourceUrl.startsWith(
            'https://www.pathofexile.com/trade/search/',
          )
        ? snapshot.sourceUrl
        : null;
  } catch (error) {
    if (
      !(error instanceof DomainError) ||
      error.code !== 'MARKET_QUERY_INVALID'
    )
      throw error;
    reasons.push(
      'Structured Trade mappings are unsupported; correct the profile before collection.',
    );
  }
  const empty = {
    targetId: target.id,
    targetDigest: target.digest,
    name: target.name,
    league: target.league,
    patch: target.patch,
    builds: target.builds,
    sources: target.sources,
    rules: target.beltRules ?? null,
    method: method ?? null,
    snapshotId: snapshot?.id ?? null,
    dataKind: snapshot?.dataKind ?? null,
    capturedAt: snapshot?.capturedAt ?? null,
    sourceUrl: snapshot?.sourceUrl ?? null,
    comparison,
    priceEvidence: [] as unknown[],
    calculation: null as null | {
      expectedCraftCost: string;
      askingPrice: string;
      spread: string;
      roiPercent: string;
      costRange: { min: string; max: string } | null;
      askingRange: { min: number; max: number } | null;
      currency: string;
      breakdown: unknown;
    },
    status: 'INSUFFICIENT_DATA' as
      'INSUFFICIENT_DATA' | 'RESEARCH' | 'CALCULATED',
    economicConclusion: null as null | 'POSITIVE' | 'NON_POSITIVE',
    freshness: !snapshot
      ? ('MISSING' as const)
      : now < Date.parse(snapshot.capturedAt) ||
          now - Date.parse(snapshot.capturedAt) > DAY
        ? ('STALE' as const)
        : ('FRESH' as const),
    confidence: 'LOW' as 'LOW' | 'MEDIUM',
    queryUrl,
    reasons,
  };
  if (!snapshot || !comparison || !method)
    return {
      ...empty,
      status: (!method && !snapshot ? 'RESEARCH' : 'INSUFFICIENT_DATA') as
        'RESEARCH' | 'INSUFFICIENT_DATA',
    };
  const base = await resolvePrice({
    evidence: priceUpdate?.basePrice ?? method.basePrice,
    label: target.baseTypes[0] ?? '',
    target,
    snapshot,
    economy,
    base: true,
    now,
  });
  const materials = await Promise.all(
    method.materials.map((material) => {
      const price = priceUpdate
        ? priceUpdate.materialPrices[material.id]
        : material.price;
      if (!price) return Promise.resolve(null);
      return resolvePrice({
        evidence: price,
        label: material.label,
        target,
        snapshot,
        economy,
        base: false,
        now,
      });
    }),
  );
  const finishing = await Promise.all(
    (method.finishing ?? []).map((entry) =>
      resolvePrice({
        evidence: priceUpdate?.finishingPrices?.[entry.id] ?? entry.price,
        label: entry.label,
        target,
        snapshot,
        economy,
        base: false,
        now,
      }),
    ),
  );
  const recovery = method.baseFailurePolicy?.recoveryPrice
    ? await resolvePrice({
        evidence:
          priceUpdate?.recoveryPrice ?? method.baseFailurePolicy.recoveryPrice,
        label: 'Base recovery',
        target,
        snapshot,
        economy,
        base: true,
        now,
      })
    : null;
  if (method.baseFailurePolicy?.recoveryPrice && !recovery)
    reasons.push('Base recovery price missing or mismatched.');
  if (finishing.some((price) => !price))
    reasons.push('Finishing prices missing or mismatched.');
  if (!base)
    reasons.push(
      'Base price missing, stale or scope/currency/provenance mismatch; BaseType does not prove item level.',
    );
  method.materials.forEach((material, i) => {
    if (!materials[i])
      reasons.push(
        `Material price unavailable or mismatched: ${material.label}.`,
      );
  });
  const priceEvidence = [
    base?.evidence ?? null,
    ...materials.map((price) => price?.evidence ?? null),
    ...finishing.map((price) => price?.evidence ?? null),
    ...(recovery ? [recovery.evidence] : []),
  ];
  if (reasons.length || !base || materials.some((price) => !price))
    return { ...empty, priceEvidence };
  const listings: MarketListing[] = comparison.rows
    .filter((row) => row.status === 'MATCH' && row.seller)
    .map((row) => ({
      account: row.seller!.toLowerCase(),
      ageSeconds: 0,
      fee: null,
      id: row.externalId ?? String(row.index),
      indexedAt: new Date(snapshot.capturedAt),
      item: {},
      price: { amount: String(row.price), currency: snapshot.currency },
    }));
  const query = {
    provider: 'poe-trade' as const,
    query: { manual: true },
    schemaVersion: 1 as const,
  };
  const parsed = {
    schemaVersion: 1,
    id: 'belt-research',
    title: target.name,
    summary: method.assumptions,
    category: 'belt',
    gameVersion: target.patch,
    tags: ['belt'],
    baseRequirements: { baseType: target.baseTypes[0], tradeQuery: query },
    craftSteps: method.steps.map((title, index) => ({
      id: `step-${index + 1}`,
      title,
    })),
    estimator: { strategy: 'cheapest' as const },
    finishingCosts: (method.finishing ?? []).map((entry) => ({
      id: entry.id,
      label: entry.label,
      quantity: entry.quantity,
      tradeQuery: query,
    })),
    materials: method.materials.map((material) => ({
      id: material.id,
      label: material.label,
      quantityPerAttempt: material.quantityPerAttempt,
      tradeQuery: query,
    })),
    output: { label: target.name, tradeQuery: query },
    success: method.success,
  };
  const aggregation = aggregateMarketListings({
    currency: snapshot.currency,
    listings,
  });
  const calculate = (attempts?: number) =>
    calculateRecipeEconomics({
      aggregation,
      basePrice: base.money,
      currency: snapshot.currency,
      finishingPrices: Object.fromEntries(
        (method.finishing ?? []).map((entry, index) => [
          entry.id,
          finishing[index]?.money,
        ]),
      ),
      ...(method.baseFailurePolicy
        ? {
            baseFailurePolicy: {
              replacementProbabilityPerFailure:
                method.baseFailurePolicy.replacementProbabilityPerFailure,
              recoveryPrice: recovery?.money ?? null,
            },
          }
        : {}),
      materialPrices: Object.fromEntries(
        method.materials.map((material, index) => [
          material.id,
          materials[index]?.money,
        ]),
      ),
      recipe:
        attempts === undefined
          ? parsed
          : {
              ...parsed,
              success: {
                mode: 'expected_attempts',
                expectedAttempts: attempts,
              },
            },
    });
  const result = calculate();
  if (!result.ok)
    return {
      ...empty,
      priceEvidence,
      reasons: [...reasons, ...result.reasons.map((reason) => reason.message)],
    };
  const lower = method.attemptsRange
    ? calculate(method.attemptsRange.min)
    : null;
  const upper = method.attemptsRange
    ? calculate(method.attemptsRange.max)
    : null;
  const askingPrices = comparison.rows
    .filter((row) => row.status === 'MATCH')
    .map((row) => row.price)
    .sort((a, b) => a - b);
  return {
    ...empty,
    status: 'CALCULATED' as const,
    confidence:
      snapshot.coverage === 'complete' &&
      !snapshot.inexact &&
      snapshot.dataKind === 'observed' &&
      target.catalog?.verification === 'verified'
        ? ('MEDIUM' as const)
        : ('LOW' as const),
    reasons:
      snapshot.coverage === 'partial' ||
      snapshot.coverage === 'unknown' ||
      snapshot.inexact
        ? [
            ...reasons,
            'Preliminary asking prices: partial or inexact market coverage; absence does not prove a sale.',
          ]
        : reasons,
    economicConclusion:
      Number(result.value.profit.amount) > 0
        ? ('POSITIVE' as const)
        : ('NON_POSITIVE' as const),
    priceEvidence,
    calculation: {
      expectedCraftCost: result.value.breakdown.expectedCraftCost.amount,
      askingPrice: result.value.estimatedSalePrice.amount,
      spread: result.value.profit.amount,
      roiPercent: result.value.marginPercent,
      costRange:
        lower?.ok && upper?.ok
          ? {
              min: lower.value.breakdown.expectedCraftCost.amount,
              max: upper.value.breakdown.expectedCraftCost.amount,
            }
          : null,
      askingRange: askingPrices.length
        ? { min: askingPrices[0]!, max: askingPrices[askingPrices.length - 1]! }
        : null,
      currency: snapshot.currency,
      breakdown: result.value.breakdown,
    },
  };
}
