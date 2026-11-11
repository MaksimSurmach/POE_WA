import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { buildApi } from './api.js';
import { createCraftAnalysisService } from './craftAnalysis.js';
import type { CraftAnalysisRepository } from './repositories/craftAnalysisRepository.js';
import { createInMemoryRepositories } from '@poe-worksmith/domain';
import { canonicalRecipeFixture } from '@poe-worksmith/domain/fixtures';
import {
  craftAnalysisFixture,
  craftModelFixture,
  craftFixtureAt,
} from './testkit/craftAnalysis.js';

async function apiFixture() {
  const repositories = createInMemoryRepositories();
  const input = craftAnalysisFixture();
  await repositories.recipes.save({
    id: input.recipeId,
    active: true,
    category: 'cluster-jewel',
    contentHash: input.recipeHash,
    craftMethod: 'synthetic',
    definition: { ...canonicalRecipeFixture },
    gameVersion: 'fixture',
    guideMarkdown: '',
    title: 'Synthetic recipe',
    tags: [],
  });
  await repositories.leagues.upsert({
    gggId: input.league,
    name: input.league,
    game: 'poe1',
    realm: 'pc',
    startAt: null,
    endAt: null,
    isCurrent: true,
    metadata: {},
    syncedAt: new Date(craftFixtureAt),
  });
  const repository = {
    latestModel: vi.fn().mockResolvedValue(null),
    saveModel: vi.fn(),
    findRun: vi.fn().mockResolvedValue(null),
  } as unknown as CraftAnalysisRepository;
  const service = createCraftAnalysisService({
    repository,
    recipes: repositories.recipes,
    leagues: repositories.leagues,
    maximumQuoteAgeMs: async () => 60000,
    runWorker: false,
    clock: () => new Date(craftFixtureAt),
  });
  const api = buildApi(
    pino({ level: 'silent' }),
    async () => {},
    async () => ({ active: null, published: null }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { craftAnalysis: service },
  );
  return { api, input, repository, repositories };
}

describe('craft analysis access and missing-evidence contracts', () => {
  it('returns a precise unavailable state instead of inventing outcome probabilities', async () => {
    const { api, input } = await apiFixture();
    try {
      const response = await api.inject({
        url: `/api/recipes/${input.recipeId}/analysis`,
        headers: { host: 'localhost' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        recipeHash: input.recipeHash,
        league: input.league,
        modelRecord: null,
        analysis: null,
        canEdit: true,
      });
      expect(response.json().data.unavailableReasons[0]).toContain(
        'missing outcome probabilities',
      );
      expect(
        (
          await api.inject({
            url: `/api/recipes/${input.recipeId}/analysis?league=unknown`,
            headers: { host: 'localhost' },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await api.close();
    }
  });
  it('exposes an embedded recipe model for explicit owner save without inventing a persisted revision', async () => {
    const { api, input, repositories } = await apiFixture();
    const recipe = (await repositories.recipes.findById(input.recipeId))!;
    await repositories.recipes.save({
      ...recipe,
      definition: {
        ...canonicalRecipeFixture,
        craft: { ...canonicalRecipeFixture.craft, outcomeModel: input.model },
      },
    });
    try {
      const response = await api.inject({
        url: `/api/recipes/${input.recipeId}/analysis`,
        headers: { host: 'localhost' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        embeddedModel: input.model,
        modelRecord: null,
        analysis: null,
        prices: {},
        valuations: {},
      });
      expect(response.json().data.unavailableReasons[0]).toContain(
        'save a revision',
      );
    } finally {
      await api.close();
    }
  });
  it.each([
    { remoteAddress: '192.0.2.1', headers: { host: 'localhost' } },
    {
      remoteAddress: '127.0.0.1',
      headers: { host: 'localhost', origin: 'https://attacker.invalid' },
    },
    {
      remoteAddress: '127.0.0.1',
      headers: { host: 'localhost', 'x-forwarded-for': '127.0.0.1' },
    },
  ])(
    'allows private model writes and run reads from $remoteAddress / $headers',
    async (connection) => {
      const { api, input, repository } = await apiFixture();
      vi.mocked(repository.saveModel).mockResolvedValue(craftModelFixture());
      try {
        for (const request of [
          {
            method: 'POST' as const,
            url: '/api/admin/craft-analysis/models',
            payload: input,
          },
          {
            method: 'GET' as const,
            url: '/api/admin/craft-analysis/simulations/00000000-0000-4000-8000-000000000001',
          },
        ])
          expect(
            (await api.inject({ ...request, ...connection })).statusCode,
          ).toBe(request.method === 'POST' ? 200 : 404);
        expect(repository.saveModel).toHaveBeenCalled();
      } finally {
        await api.close();
      }
    },
  );
  it('rejects a target-success outcome for a different exact recipe target', async () => {
    const { api, input, repository } = await apiFixture();
    vi.mocked(repository.saveModel).mockResolvedValue(craftModelFixture());
    input.model.stages[0]!.outcomes[0]!.matching = {
      kind: 'exact-target',
      targetSignature: 'different-target',
    };
    input.valuations.target!.matching = {
      kind: 'exact-target',
      targetSignature: 'different-target',
    };
    try {
      const response = await api.inject({
        method: 'POST',
        url: '/api/admin/craft-analysis/models',
        headers: { host: 'localhost' },
        payload: input,
      });
      expect(response.statusCode).toBe(400);
      expect(repository.saveModel).not.toHaveBeenCalled();
    } finally {
      await api.close();
    }
  });
  it('allows a non-target salvage outcome to match a different exact target', async () => {
    const { api, input, repository } = await apiFixture();
    vi.mocked(repository.saveModel).mockResolvedValue(craftModelFixture());
    input.model.stages[0]!.outcomes[1]!.matching = {
      kind: 'exact-target',
      targetSignature: 'salvage-target',
    };
    input.valuations.salvage!.matching = {
      kind: 'exact-target',
      targetSignature: 'salvage-target',
    };
    try {
      const response = await api.inject({
        method: 'POST',
        url: '/api/admin/craft-analysis/models',
        headers: { host: 'localhost' },
        payload: input,
      });
      expect(response.statusCode).toBe(200);
      expect(repository.saveModel).toHaveBeenCalledWith(
        input,
        expect.objectContaining({
          targetSignature: canonicalRecipeFixture.targetSignature,
        }),
      );
    } finally {
      await api.close();
    }
  });
  it('rejects malformed JSON and operator-fabricated live quote metadata', async () => {
    const { api, input, repository } = await apiFixture();
    try {
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/api/admin/craft-analysis/models',
            headers: { host: 'localhost', 'content-type': 'application/json' },
            payload: '{',
          })
        ).statusCode,
      ).toBe(400);
      input.prices.base!.provenance.kind = 'market-observation';
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/api/admin/craft-analysis/models',
            headers: { host: 'localhost' },
            payload: input,
          })
        ).statusCode,
      ).toBe(400);
      expect(repository.saveModel).not.toHaveBeenCalled();
    } finally {
      await api.close();
    }
  });
});
