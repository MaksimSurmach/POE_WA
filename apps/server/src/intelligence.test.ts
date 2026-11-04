import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { buildApi } from './api.js';
import { canonicalRecipeFixture } from '@poe-worksmith/domain/fixtures';
import {
  outcomeAnalysisInputSchema,
  createInMemoryRepositories,
  allocateCapital,
  intelligenceSettingsSchema,
  riskSimulationRequestSchema,
  simulateCraftingRisk,
  intelligenceRiskOptionSchema,
} from '@poe-worksmith/domain';
import {
  marketAdminSettingsSchema,
  marketAdminPatchSchema,
} from '@poe-worksmith/contracts';
import {
  craftAnalysisFixture,
  craftFixtureAt,
} from './testkit/craftAnalysis.js';
import { defaultAdminSettings } from './marketAdmin.js';
import {
  intelligenceMonetaryFingerprint,
  assertProductionLeagueWindow,
  createIntelligenceService,
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
  it('keeps read defaults out of partial writes and rejects an empty patch', () => {
    expect(
      marketAdminPatchSchema.safeParse({ version: 0, settings: {} }).success,
    ).toBe(false);
    expect(
      marketAdminPatchSchema.parse({
        version: 0,
        settings: { requestTimeoutMs: 12000 },
      }).settings,
    ).toEqual({ requestTimeoutMs: 12000 });
  });

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

describe('production league observation window', () => {
  const at = new Date('2026-11-04T12:00:00.000Z');
  it('allows permanent leagues without invented boundaries and the exact start instant', () => {
    expect(() =>
      assertProductionLeagueWindow({ startAt: null, endAt: null }, at),
    ).not.toThrow();
    expect(() =>
      assertProductionLeagueWindow(
        { startAt: at, endAt: new Date(at.getTime() + 1) },
        at,
      ),
    ).not.toThrow();
  });
  it('rejects future leagues and the exact end instant', () => {
    for (const league of [
      { startAt: new Date(at.getTime() + 1), endAt: null },
      { startAt: null, endAt: at },
      { startAt: null, endAt: new Date(at.getTime() - 1) },
    ]) {
      expect(() => assertProductionLeagueWindow(league, at)).toThrowError(
        expect.objectContaining({ code: 'INTELLIGENCE_LEAGUE_INACTIVE' }),
      );
    }
  });
});

it('rejects inactive-league recommendations through the API while preserving historical reads', async () => {
  const now = new Date('2026-11-04T12:00:00.000Z');
  const repositories = createInMemoryRepositories();
  const league = await repositories.leagues.upsert({
    gggId: 'Ended fixture',
    name: 'Ended fixture',
    game: 'poe1',
    realm: 'pc',
    startAt: null,
    endAt: now,
    isCurrent: false,
    metadata: {},
    syncedAt: now,
  });
  await repositories.recipes.save({
    id: canonicalRecipeFixture.id,
    active: true,
    category: 'cluster-jewel',
    contentHash: 'history-revision',
    craftMethod: 'synthetic',
    definition: { ...canonicalRecipeFixture },
    gameVersion: 'fixture',
    guideMarkdown: '',
    title: 'Synthetic history',
    tags: [],
  });
  const settings = intelligenceSettingsSchema.parse({});
  const capital = {
    quantity: '1',
    unitPrice: '100',
    currency: 'chaos' as const,
    chaosPerUnit: '1',
    rateSource: 'synthetic',
  };
  const request = {
    league: league.gggId,
    capital,
    reserve: { ...capital, unitPrice: '10' },
    maxRiskProbability: 0.25,
    maxExposurePercent: 50,
    horizonDays: 7,
  };
  const saved = {
    id: randomUUID(),
    createdAt: '2026-11-03T12:00:00.000Z',
    plan: allocateCapital({
      request,
      candidates: [],
      settings,
      now: '2026-11-03T12:00:00.000Z',
    }),
  };
  const options = {
    repository: {
      history: async () => [],
      findPlan: async () => ({ view: saved }),
      findPlanRetry: async () => null,
    },
    factory: {
      list: async () => ({ batches: [], total: 0, limit: 100, offset: 0 }),
    },
    analysis: {},
    recipes: repositories.recipes,
    leagues: repositories.leagues,
    marketDependencies: async () => [],
    settings: async () => settings,
    maximumQuoteAgeMs: async () => 3600000,
    clock: () => now,
    runWorker: false,
  } as unknown as Parameters<typeof createIntelligenceService>[0];
  const service = createIntelligenceService(options);
  const api = buildApi(
    pino({ level: 'silent' }),
    async () => {},
    async () => ({ active: null, published: null }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { intelligence: service },
  );
  try {
    const response = await api.inject({
      url: `/api/admin/intelligence/opportunities?league=${encodeURIComponent(league.gggId)}`,
      headers: { host: 'localhost' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'INTELLIGENCE_LEAGUE_INACTIVE',
      message:
        'Production recommendations are unavailable before a league starts or after it ends.',
    });
    expect(
      (
        await api.inject({
          method: 'POST',
          url: '/api/admin/intelligence/allocations',
          headers: { host: 'localhost' },
          payload: { ...request, idempotencyKey: randomUUID() },
        })
      ).statusCode,
    ).toBe(400);
    const history = await api.inject({
      url: `/api/admin/intelligence/recipes/${canonicalRecipeFixture.id}/history?league=${encodeURIComponent(league.gggId)}`,
      headers: { host: 'localhost' },
    });
    expect(history.statusCode, history.body).toBe(200);
    const plan = await api.inject({
      url: `/api/admin/intelligence/allocations/${saved.id}`,
      headers: { host: 'localhost' },
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().data).toEqual(saved);
  } finally {
    await api.close();
  }
});
