import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DomainError,
  analyzeOutcomeModel,
  factoryBatchSchema,
  outcomeAnalysisInputSchema,
  summarizeFactoryBatches,
  type Repositories,
} from '@poe-worksmith/domain';
import {
  factoryCreateBatchInputSchema,
  factoryAppendEventInputSchema,
} from '@poe-worksmith/contracts';
import type { CraftAnalysisService } from './craftAnalysis.js';
import type { FactoryRepository } from './repositories/factoryRepository.js';
import { craftRequestHash } from './repositories/craftAnalysisRepository.js';

export function factoryCsvCell(value: unknown): string {
  let text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  // Spreadsheet applications can execute formulas even after CSV quoting.
  if (/^[\s]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function createFactoryService(options: {
  repository: FactoryRepository;
  analysis: CraftAnalysisService;
  leagues: Repositories['leagues'];
  clock?: () => Date;
}) {
  const now = () => (options.clock?.() ?? new Date()).toISOString();
  const id = (input: unknown) => {
    const parsed = z.uuid().safeParse(input);
    if (!parsed.success) throw new DomainError('MARKET_QUERY_INVALID');
    return parsed.data;
  };
  async function leagueId(name: string) {
    const found = (await options.leagues.list()).find(
      (l) => l.gggId === name && l.game === 'poe1' && l.realm === 'pc',
    );
    if (!found) throw new DomainError('MARKET_QUERY_INVALID');
    return found.id;
  }
  return {
    async create(raw: unknown) {
      const parsed = factoryCreateBatchInputSchema.safeParse(raw);
      if (!parsed.success) throw new DomainError('CALCULATION_INPUT_INVALID');
      const input = parsed.data;
      const hash = craftRequestHash({ operation: 'create', input });
      const previous = await options.repository.findMutation(
        input.idempotencyKey,
        hash,
        now(),
      );
      if (previous) return previous;
      const analysis = await options.analysis.readAnalysis(
        input.recipeId,
        input.league,
        true,
      );
      if (analysis.recipeHash !== input.recipeHash)
        throw new DomainError('PERSISTENCE_CONFLICT');
      if (!analysis.leagueId || analysis.league !== input.league)
        throw new DomainError('MARKET_QUERY_INVALID');
      const risk = input.forecastRunId
        ? await options.analysis.readSimulation(input.forecastRunId)
        : null;
      if (
        risk &&
        (risk.recipeId !== input.recipeId ||
          risk.recipeHash !== input.recipeHash ||
          risk.leagueId !== analysis.leagueId ||
          risk.modelId !== analysis.modelRecord?.id ||
          risk.status !== 'completed' ||
          risk.result?.status !== 'complete')
      )
        throw new DomainError('PERSISTENCE_CONFLICT');
      const model = analysis.modelRecord;
      const forecast =
        model && analysis.analysis
          ? {
              sourceId: model.id,
              analysisInput:
                risk?.request.analysis ??
                outcomeAnalysisInputSchema.parse({
                  model: model.model,
                  currency: model.currency,
                  league: input.league,
                  now: analysis.evaluatedAt,
                  prices: analysis.prices,
                  valuations: analysis.valuations,
                }),
              analysis: risk
                ? analyzeOutcomeModel(risk.request.analysis)
                : analysis.analysis,
              riskRequest: risk?.request ?? null,
              riskResult: risk?.result ?? null,
            }
          : null;
      const batch = factoryBatchSchema.parse({
        id: randomUUID(),
        recipeId: input.recipeId,
        recipeHash: input.recipeHash,
        targetSignature: analysis.targetSignature,
        leagueId: analysis.leagueId,
        league: input.league,
        accountingCurrency: 'chaos',
        startedAt: now(),
        plannedBudget: input.plannedBudget,
        notes: input.notes,
        forecast,
        forecastUnavailableReasons: analysis.unavailableReasons,
      });
      return options.repository.create(
        batch,
        input.idempotencyKey,
        hash,
        now(),
      );
    },
    async append(batchId: string, raw: unknown) {
      const parsed = factoryAppendEventInputSchema.safeParse(raw);
      if (!parsed.success) throw new DomainError('CALCULATION_INPUT_INVALID');
      const input = parsed.data;
      return options.repository.append(
        id(batchId),
        input.expectedVersion,
        input.event,
        input.idempotencyKey,
        now(),
      );
    },
    async get(batchId: string) {
      return options.repository.get(id(batchId), now());
    },
    async list(league: string, limit = 50, offset = 0) {
      return options.repository.list(
        await leagueId(league),
        now(),
        limit,
        offset,
      );
    },
    async summary(league: string) {
      const listing = await options.repository.list(
        await leagueId(league),
        now(),
        100,
        0,
      );
      return {
        accountingCurrency: 'chaos' as const,
        asOf: now(),
        metrics: summarizeFactoryBatches(
          listing.batches.map((b) => b.projection),
        ),
        coverage: {
          complete: listing.total <= 100,
          totalBatches: listing.total,
          includedBatches: listing.batches.length,
        },
      };
    },
    async inventory(league: string, limit = 50, offset = 0) {
      const listing = await options.repository.list(
        await leagueId(league),
        now(),
        limit,
        offset,
      );
      return {
        items: listing.batches.flatMap((r) =>
          r.projection.inventory.map((item) => ({
            ...item,
            batchId: r.batch.id,
            recipeId: r.batch.recipeId,
          })),
        ),
        coverage: {
          complete: offset === 0 && listing.total <= limit,
          totalBatches: listing.total,
          includedBatches: listing.batches.length,
        },
      };
    },
    async sales(league: string, limit = 50, offset = 0) {
      const listing = await options.repository.list(
        await leagueId(league),
        now(),
        limit,
        offset,
      );
      return {
        sales: listing.batches.flatMap((r) =>
          r.projection.sales.map((sale) => ({
            ...sale,
            batchId: r.batch.id,
            recipeId: r.batch.recipeId,
          })),
        ),
        coverage: {
          complete: offset === 0 && listing.total <= limit,
          totalBatches: listing.total,
          includedBatches: listing.batches.length,
        },
      };
    },
    async export(batchId: string, format: 'json' | 'csv') {
      const record = await options.repository.get(id(batchId), now());
      if (format === 'json') return JSON.stringify(record, null, 2);
      return [
        ['event_id', 'occurred_at', 'source', 'notes', 'payload']
          .map(factoryCsvCell)
          .join(','),
        ...record.events.map((event) =>
          [event.id, event.occurredAt, event.source, event.notes, event.payload]
            .map(factoryCsvCell)
            .join(','),
        ),
      ].join('\r\n');
    },
  };
}
export type FactoryService = ReturnType<typeof createFactoryService>;
