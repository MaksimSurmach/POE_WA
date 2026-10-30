import type {
  MarketResearchSnapshot,
  MarketTarget,
  BeltPriceUpdate,
} from '@poe-worksmith/contracts';
import {
  aggregateMarketListings,
  validateRecipeV1,
  type MarketListing,
} from '@poe-worksmith/domain';
import { calculateRecipeEconomics } from '@poe-worksmith/domain/economics';
import { analyzeBeltSnapshot } from './beltComparability.js';
import type { MarketEconomyRepository } from './marketEconomy.js';

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
      evidence.currency !== snapshot.currency ||
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
    return {
      money: { amount: String(evidence.amount), currency: evidence.currency },
      evidence,
    };
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
  if (
    !line ||
    line.name !== input.label ||
    !line.price.amount ||
    line.price.currency !== snapshot.currency
  )
    return null;
  return {
    money: { amount: String(line.price.amount), currency: line.price.currency },
    evidence: {
      ...evidence,
      url: stored.endpoint,
      capturedAt: stored.capturedAt,
      league: stored.league,
      category: stored.category,
      name: line.name,
      amount: line.price.amount,
      currency: line.price.currency,
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
  if (!target.beltRules) reasons.push('Executable belt rules are missing.');
  if (!method)
    reasons.push('Craft method, probability and prices are missing.');
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
      currency: string;
      breakdown: unknown;
    },
    status: 'INSUFFICIENT_DATA' as
      'INSUFFICIENT_DATA' | 'RESEARCH' | 'CALCULATED',
    economicConclusion: null as null | 'POSITIVE' | 'NON_POSITIVE',
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
  const parsed = validateRecipeV1({
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
    estimator: { strategy: 'cheapest' },
    finishingCosts: [],
    materials: method.materials.map((material) => ({
      id: material.id,
      label: material.label,
      quantityPerAttempt: material.quantityPerAttempt,
      tradeQuery: query,
    })),
    output: { label: target.name, tradeQuery: query },
    success: method.success,
  });
  const aggregation = aggregateMarketListings({
    currency: snapshot.currency,
    listings,
  });
  const result = calculateRecipeEconomics({
    aggregation,
    basePrice: base.money,
    currency: snapshot.currency,
    finishingPrices: {},
    materialPrices: Object.fromEntries(
      method.materials.map((material, index) => [
        material.id,
        materials[index]?.money,
      ]),
    ),
    recipe: parsed,
  });
  if (!result.ok)
    return {
      ...empty,
      priceEvidence,
      reasons: [...reasons, ...result.reasons.map((reason) => reason.message)],
    };
  return {
    ...empty,
    status: 'CALCULATED' as const,
    economicConclusion:
      Number(result.value.profit.amount) > 0
        ? ('POSITIVE' as const)
        : ('NON_POSITIVE' as const),
    priceEvidence,
    calculation: {
      expectedCraftCost: result.value.breakdown.expectedCraftCost.amount,
      askingPrice: result.value.estimatedSalePrice.amount,
      spread: result.value.profit.amount,
      currency: snapshot.currency,
      breakdown: result.value.breakdown,
    },
  };
}
