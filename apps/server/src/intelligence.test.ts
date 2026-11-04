import { describe, expect, it } from 'vitest';
import {
  outcomeAnalysisInputSchema,
  riskSimulationRequestSchema,
  simulateCraftingRisk,
  intelligenceRiskOptionSchema,
} from '@poe-worksmith/domain';
import { marketAdminSettingsSchema } from '@poe-worksmith/contracts';
import {
  craftAnalysisFixture,
  craftFixtureAt,
} from './testkit/craftAnalysis.js';
import { defaultAdminSettings } from './marketAdmin.js';
import {
  intelligenceMonetaryFingerprint,
  matchingCurrentRisk,
} from './intelligence.js';

describe('current risk evidence compatibility', () => {
  it('allows fresh unchanged monetary evidence but rejects changed costs, resale or expired frozen quotes', async () => {
    const fixture = craftAnalysisFixture();
    const input = outcomeAnalysisInputSchema.parse({
      model: fixture.model,
      currency: fixture.currency,
      league: fixture.league,
      now: craftFixtureAt,
      prices: fixture.prices,
      valuations: fixture.valuations,
    });
    const quote = input.valuations.target!;
    quote.provenance = {
      kind: 'market-observation',
      reference: 'first',
      recordedAt: craftFixtureAt,
      notes: 'synthetic',
    };
    quote.market = {
      league: input.league,
      observedAt: craftFixtureAt,
      expiresAt: '2026-11-04T12:30:00.000Z',
      coverage: 'complete',
      independentSellers: 3,
    };
    const request = riskSimulationRequestSchema.parse({
      analysis: input,
      objective: { kind: 'attempts', count: 1 },
      seed: 'synthetic',
      trials: 100,
      budget: '20',
    });
    const result = await simulateCraftingRisk(request);
    const option = intelligenceRiskOptionSchema.parse({
      id: 'synthetic-risk',
      recipeId: fixture.recipeId,
      recipeHash: fixture.recipeHash,
      targetSignature: 'synthetic',
      league: input.league,
      createdAt: craftFixtureAt,
      request,
      result,
    });
    const next = structuredClone(input);
    next.now = '2026-11-04T12:01:00.000Z';
    next.valuations.target!.provenance.reference = 'second';
    next.valuations.target!.market!.observedAt = next.now;
    expect(intelligenceMonetaryFingerprint(next)).toBe(
      intelligenceMonetaryFingerprint(input),
    );
    expect(matchingCurrentRisk(option, next, next.now)).toBe(true);
    next.prices.base!.amount = '20';
    expect(matchingCurrentRisk(option, next, next.now)).toBe(false);
    next.prices.base!.amount = input.prices.base!.amount;
    next.valuations.target!.min = '11';
    next.valuations.target!.max = '11';
    expect(matchingCurrentRisk(option, next, next.now)).toBe(false);
    expect(matchingCurrentRisk(option, input, '2026-11-04T12:31:00.000Z')).toBe(
      false,
    );
  });
});
describe('existing admin settings compatibility', () => {
  it('adds intelligence defaults to saved settings without changing existing controls', () => {
    const complete = defaultAdminSettings({
      refreshCron: '*/5 * * * *',
      requestTimeoutMs: 5000,
      concurrency: 2,
      snapshotTtlMs: 60000,
    });
    const old = Object.fromEntries(
      Object.entries(complete).filter(([key]) => key !== 'intelligence'),
    );
    const parsed = marketAdminSettingsSchema.parse(old);
    expect(parsed.intelligence.minIndependentSellers).toBe(2);
    expect(parsed.intelligence.minConfirmations).toBe(2);
    expect(parsed.intelligence.minOwnSaleSamples).toBe(3);
    expect(parsed.maximumQuoteAgeMs).toBe(old.maximumQuoteAgeMs);
    expect(
      marketAdminSettingsSchema.safeParse({
        ...old,
        intelligence: { minIndependentSellers: 1 },
      }).success,
    ).toBe(false);
  });
});
