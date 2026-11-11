import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryRepositories,
  analyzeOutcomeModel,
  outcomeAnalysisInputSchema,
  simulateCraftingRisk,
  riskSimulationRequestSchema,
  factoryBatchSchema,
  FactoryLedgerError,
  projectFactoryBatch,
} from '@poe-worksmith/domain';
import {
  craftAnalysisFixture,
  craftModelFixture,
} from './testkit/craftAnalysis.js';
import {
  craftRiskRunSchema,
  craftAnalysisSchema,
} from '@poe-worksmith/contracts';
import { buildApi } from './api.js';
import { createFactoryService, factoryCsvCell } from './factory.js';
import type { CraftAnalysisService } from './craftAnalysis.js';
import type { FactoryRepository } from './repositories/factoryRepository.js';
const at = '2026-11-04T12:00:00.000Z';
const transaction = {
  quantity: '1',
  unitPrice: '100',
  currency: 'chaos',
  chaosPerUnit: '1',
  rateSource: 'synthetic:rate',
};
async function setup() {
  const repositories = createInMemoryRepositories();
  const league = await repositories.leagues.upsert({
    gggId: 'Fixture',
    name: 'Fixture',
    game: 'poe1',
    realm: 'pc',
    startAt: null,
    endAt: null,
    isCurrent: true,
    metadata: {},
    syncedAt: new Date(at),
  });
  const batch = factoryBatchSchema.parse({
    id: randomUUID(),
    recipeId: 'test',
    recipeHash: 'revision',
    targetSignature: 'target',
    leagueId: league.id,
    league: 'Fixture',
    accountingCurrency: 'chaos',
    startedAt: at,
    plannedBudget: transaction,
    notes: '',
    forecast: null,
  });
  const record = {
    batch,
    events: [],
    projection: projectFactoryBatch(batch, [], at),
    version: 0,
  };
  const repository = {
    findMutation: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(record),
    append: vi.fn().mockResolvedValue(record),
    get: vi.fn().mockResolvedValue(record),
    list: vi.fn().mockResolvedValue({
      batches: [{ batch, projection: record.projection, version: 0 }],
      total: 1,
      limit: 50,
      offset: 0,
    }),
  } as unknown as FactoryRepository;
  const analysis = {
    readAnalysis: vi.fn().mockResolvedValue({
      recipeId: 'test',
      recipeHash: 'revision',
      targetSignature: 'target',
      league: 'Fixture',
      leagueId: league.id,
      modelRecord: null,
      analysis: null,
      prices: {},
      valuations: {},
      unavailableReasons: ['Missing outcome probabilities'],
    }),
    readSimulation: vi.fn(),
  } as unknown as CraftAnalysisService;
  const service = createFactoryService({
    repository,
    analysis,
    leagues: repositories.leagues,
    clock: () => new Date(at),
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
    { factory: service },
  );
  return { api, service, repository, analysis, record };
}
describe('private factory API and immutable forecast context', () => {
  it('accepts historical starts, rejects future starts and hashes the original historical metadata', async () => {
    const { api, service, repository, record } = await setup();
    try {
      const input = {
        recipeId: 'test',
        recipeHash: 'revision',
        league: 'Fixture',
        plannedBudget: transaction,
        idempotencyKey: randomUUID(),
        startedAt: '2026-11-03T12:00:00.000Z',
      };
      await service.create(input);
      const firstCall = vi.mocked(repository.create).mock.calls[0]!;
      expect(firstCall[0].startedAt).toBe(input.startedAt);
      expect(firstCall[3]).toBe(at);
      await service.create(input);
      expect(vi.mocked(repository.create).mock.calls[1]![2]).toBe(firstCall[2]);
      await service.create({ ...input, startedAt: '2026-11-02T12:00:00.000Z' });
      expect(vi.mocked(repository.create).mock.calls[2]![2]).not.toBe(
        firstCall[2],
      );
      vi.mocked(repository.findMutation).mockResolvedValue({
        ...record,
        batch: { ...record.batch, startedAt: input.startedAt },
      });
      expect((await service.create(input)).batch.startedAt).toBe(
        input.startedAt,
      );
      const response = await api.inject({
        method: 'POST',
        url: '/api/admin/factory/batches',
        headers: { host: 'localhost' },
        payload: { ...input, startedAt: '2026-11-05T12:00:00.000Z' },
      });
      expect(response.statusCode).toBe(400);
      expect(repository.create).toHaveBeenCalledTimes(3);
    } finally {
      await api.close();
    }
  });

  it('serves typed league-scoped summaries and discloses incomplete coverage', async () => {
    const { api, repository, record } = await setup();
    try {
      for (const route of ['batches', 'summary', 'inventory', 'sales']) {
        const response = await api.inject({
          url: `/api/admin/factory/${route}?league=Fixture`,
          headers: { host: 'localhost' },
        });
        expect(response.statusCode, response.body).toBe(200);
      }
      vi.mocked(repository.list).mockResolvedValue({
        batches: [
          { batch: record.batch, projection: record.projection, version: 0 },
        ],
        total: 101,
        limit: 100,
        offset: 0,
      });
      const response = await api.inject({
        url: '/api/admin/factory/summary?league=Fixture',
        headers: { host: 'localhost' },
      });
      expect(response.json().data.coverage).toEqual({
        complete: false,
        totalBatches: 101,
        includedBatches: 1,
      });
    } finally {
      await api.close();
    }
  });

  it('freezes the selected simulation evidence instead of recombining it with newer prices', async () => {
    const { api, service, analysis, repository, record } = await setup();
    try {
      const fixture = craftAnalysisFixture();
      const model = {
        ...craftModelFixture(),
        recipeId: 'test',
        recipeHash: 'revision',
        league: 'Fixture',
        leagueId: record.batch.leagueId,
      };
      const original = outcomeAnalysisInputSchema.parse({
        model: model.model,
        currency: 'chaos',
        league: 'Fixture',
        now: at,
        prices: fixture.prices,
        valuations: fixture.valuations,
      });
      const request = riskSimulationRequestSchema.parse({
        analysis: original,
        objective: { kind: 'attempts', count: 2 },
        seed: 'synthetic-frozen',
        trials: 100,
        budget: '20',
      });
      const result = await simulateCraftingRisk(request);
      const risk = craftRiskRunSchema.parse({
        id: randomUUID(),
        modelId: model.id,
        recipeId: 'test',
        recipeHash: 'revision',
        leagueId: record.batch.leagueId,
        calculationVersion: analyzeOutcomeModel(original).calculationVersion,
        request,
        status: 'completed',
        progress: 100,
        result,
        error: null,
        cancelRequested: false,
        createdAt: at,
        startedAt: at,
        finishedAt: at,
      });
      const later = {
        ...original,
        prices: {
          ...original.prices,
          base: { ...original.prices.base!, amount: '99' },
        },
      };
      vi.mocked(analysis.readAnalysis).mockResolvedValue(
        craftAnalysisSchema.parse({
          recipeId: 'test',
          recipeHash: 'revision',
          targetSignature: record.batch.targetSignature,
          league: 'Fixture',
          leagueId: record.batch.leagueId,
          evaluatedAt: at,
          modelRecord: model,
          embeddedModel: null,
          analysis: analyzeOutcomeModel(later),
          prices: later.prices,
          valuations: later.valuations,
          unavailableReasons: [],
          canEdit: true,
        }),
      );
      vi.mocked(analysis.readSimulation).mockResolvedValue(risk);
      const input = {
        recipeId: 'test',
        recipeHash: 'revision',
        league: 'Fixture',
        plannedBudget: transaction,
        idempotencyKey: randomUUID(),
        forecastRunId: risk.id,
      };
      await service.create(input);
      expect(
        vi.mocked(repository.create).mock.calls[0]![0].forecast,
      ).toMatchObject({
        sourceId: model.id,
        analysisInput: original,
        analysis: analyzeOutcomeModel(original),
        riskRequest: request,
        riskResult: result,
      });
      vi.mocked(analysis.readSimulation).mockResolvedValue({
        ...risk,
        leagueId: randomUUID(),
      });
      await expect(
        service.create({ ...input, idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
    } finally {
      await api.close();
    }
  });

  it('serves private proxy reads and validates writes without authentication', async () => {
    const { api, record, repository } = await setup();
    try {
      for (const url of [
        '/api/admin/factory/batches?league=Fixture',
        `/api/admin/factory/batches/${record.batch.id}`,
        `/api/admin/factory/batches/${record.batch.id}/export?format=json`,
        '/api/admin/factory/summary?league=Fixture',
        '/api/admin/factory/inventory?league=Fixture',
        '/api/admin/factory/sales?league=Fixture',
      ]) {
        const response = await api.inject({
          url,
          headers: { host: 'example.com' },
          remoteAddress: '203.0.113.10',
        });
        expect(response.statusCode).toBe(200);
      }
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/api/admin/factory/batches',
            headers: { host: 'example.com' },
            remoteAddress: '203.0.113.10',
            payload: {},
          })
        ).statusCode,
      ).toBe(400);
      expect(repository.get).toHaveBeenCalled();
    } finally {
      await api.close();
    }
  });
  it('creates batches with explicit missing forecast and rejects untrusted forecasts or old recipe hashes', async () => {
    const { api, repository } = await setup();
    try {
      const input = {
        recipeId: 'test',
        recipeHash: 'revision',
        league: 'Fixture',
        plannedBudget: transaction,
        idempotencyKey: randomUUID(),
      };
      const post = (payload: Record<string, unknown>) =>
        api.inject({
          method: 'POST',
          url: '/api/admin/factory/batches',
          headers: { host: 'localhost' },
          payload,
        });
      expect((await post(input)).statusCode).toBe(200);
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          forecast: null,
          forecastUnavailableReasons: ['Missing outcome probabilities'],
        }),
        input.idempotencyKey,
        expect.any(String),
        at,
      );
      expect(
        (await post({ ...input, forecast: { profit: '999' } })).statusCode,
      ).toBe(400);
      expect((await post({ ...input, recipeHash: 'old' })).statusCode).toBe(
        409,
      );
    } finally {
      await api.close();
    }
  });
  it('requires explicit league, bounds pagination and returns safe typed accounting errors', async () => {
    const { api, repository, record } = await setup();
    try {
      for (const suffix of [
        '',
        '?league=unknown',
        '?league=Fixture&limit=1000',
      ])
        expect(
          (
            await api.inject({
              url: `/api/admin/factory/batches${suffix}`,
              headers: { host: 'localhost' },
            })
          ).statusCode,
        ).toBe(400);
      vi.mocked(repository.append).mockRejectedValue(
        new FactoryLedgerError('Insufficient material inventory'),
      );
      const response = await api.inject({
        method: 'POST',
        url: `/api/admin/factory/batches/${record.batch.id}/events`,
        headers: { host: 'localhost' },
        payload: {
          expectedVersion: 0,
          idempotencyKey: randomUUID(),
          event: {
            id: randomUUID(),
            occurredAt: at,
            source: 'synthetic',
            notes: '',
            payload: { type: 'note', text: 'example' },
          },
        },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error).toMatchObject({
        code: 'FACTORY_LEDGER_INVALID',
        message:
          'The ledger event violates inventory or accounting constraints.',
      });
    } finally {
      await api.close();
    }
  });
  it('exports the immutable document and audit trail as a private download', async () => {
    const { api, record } = await setup();
    try {
      const response = await api.inject({
        url: `/api/admin/factory/batches/${record.batch.id}/export?format=json`,
        headers: { host: 'localhost' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.json()).toEqual(record);
    } finally {
      await api.close();
    }
  });
});
describe('CSV audit safety', () => {
  it('quotes separators/newlines and neutralizes spreadsheet formulas', () => {
    expect(factoryCsvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    for (const text of ['=HYPERLINK("x")', ' +10', '\t@SUM(A1)', '-2'])
      expect(factoryCsvCell(text)).toMatch(/^"'/);
  });
});
