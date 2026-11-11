import {
  analyzeOutcomeModel,
  outcomeAnalysisInputSchema,
  outcomeCalculationVersion,
  outcomePriceQuoteSchema,
  outcomeValueQuoteSchema,
  riskSimulationRequestSchema,
  simulateCraftingRisk,
  validateRecipeDocument,
  DomainError,
  type OutcomeAnalysisInput,
  type OutcomePriceQuote,
  type OutcomeValueQuote,
  type Repositories,
} from '@poe-worksmith/domain';
import {
  craftAnalysisSchema,
  craftModelSaveInputSchema,
  craftRiskCreateInputSchema,
  type CraftModelRecord,
  type CraftAnalysis,
} from '@poe-worksmith/contracts';
import { z } from 'zod';
import {
  craftRequestHash,
  type CraftAnalysisRepository,
} from './repositories/craftAnalysisRepository.js';

const money = z.object({ amount: z.string(), currency: z.string() });
const evidenceSchema = z.object({
  recipeContentHash: z.string(),
  oldestInputAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  baseCost: money.nullable().optional(),
  steps: z
    .array(
      z.object({
        materials: z.array(
          z.object({ itemId: z.string(), unitPrice: money.nullable() }),
        ),
      }),
    )
    .optional(),
  source: z.object({
    capturedAt: z.iso.datetime({ offset: true }),
    sampleSize: z.number().int().nonnegative(),
    coverage: z.string(),
    currencyAvailable: z.boolean(),
  }),
  saleEvidence: z.object({ status: z.string() }).optional(),
  materialEvidence: z
    .record(
      z.string(),
      z.object({
        league: z.string(),
        source: z.string(),
        capturedAt: z.iso.datetime({ offset: true }),
        verifiedAt: z.iso.datetime({ offset: true }).optional(),
        bulkSupported: z.boolean().optional(),
        sortedSampleComplete: z.boolean().optional(),
        priceBasis: z.string().optional(),
        snapshotId: z.string().optional(),
      }),
    )
    .default({}),
});

export function resolveCraftAnalysisEvidence(
  model: CraftModelRecord,
  rows: Awaited<ReturnType<CraftAnalysisRepository['readValuationCandidates']>>,
  now: Date,
  maximumAgeMs: number,
): Pick<OutcomeAnalysisInput, 'prices' | 'valuations'> {
  const prices: Record<string, OutcomePriceQuote> = {};
  const valuations: Record<string, OutcomeValueQuote> = {};
  for (const row of rows) {
    const parsed = evidenceSchema.safeParse(row.method_cost);
    if (!parsed.success) continue;
    const evidence = parsed.data;
    const oldest = Date.parse(evidence.oldestInputAt);
    const expires = Math.min(
      Date.parse(evidence.expiresAt),
      oldest + maximumAgeMs,
    );
    if (
      evidence.recipeContentHash !== row.recipe_content_hash ||
      oldest > now.getTime() ||
      expires <= now.getTime()
    )
      continue;
    const reference = `evaluation:${row.recipe_id}:${row.evaluated_at.toISOString()}:${row.source_snapshot_dedupe_key ?? 'unknown'}`;
    if (
      row.recipe_id === model.recipeId &&
      row.recipe_content_hash === model.recipeHash
    ) {
      const inputPrices = [
        ...(evidence.baseCost
          ? [{ itemId: 'base', unitPrice: evidence.baseCost }]
          : []),
        ...(evidence.steps?.flatMap((s) => s.materials) ?? []),
      ];
      for (const material of inputPrices) {
        const source = evidence.materialEvidence[material.itemId];
        if (
          !material.unitPrice ||
          !source ||
          source.league !== model.league ||
          (material.itemId !== 'base' && source.bulkSupported !== true)
        )
          continue;
        const observedAt = source.verifiedAt ?? source.capturedAt;
        const observed = Date.parse(observedAt);
        if (
          observed > now.getTime() ||
          observed + maximumAgeMs <= now.getTime()
        )
          continue;
        const quote = outcomePriceQuoteSchema.safeParse({
          ...material.unitPrice,
          provenance: {
            kind: 'market-observation',
            reference: source.snapshotId ?? reference,
            recordedAt: observedAt,
            notes: `${source.source}; ${source.priceBasis ?? 'asking'}; purchase estimate, not a completed sale`,
          },
          market: {
            league: model.league,
            observedAt,
            expiresAt: new Date(
              Math.min(expires, observed + maximumAgeMs),
            ).toISOString(),
            coverage: material.itemId === 'base' ? 'partial' : 'complete',
            independentSellers: null,
          },
        });
        if (quote.success) prices[material.itemId] = quote.data;
      }
    }
    if (
      row.currency !== model.currency ||
      row.estimated_sale_price === null ||
      evidence.source.coverage !== 'complete' ||
      evidence.source.sampleSize < 2 ||
      !evidence.source.currencyAvailable ||
      evidence.saleEvidence?.status !== 'accepted'
    )
      continue;
    const observed = Date.parse(evidence.source.capturedAt);
    if (observed > now.getTime() || observed + maximumAgeMs <= now.getTime())
      continue;
    for (const outcome of model.model.stages.flatMap((s) => s.outcomes)) {
      if (
        !outcome.sellable ||
        outcome.matching.kind !== 'exact-target' ||
        outcome.matching.targetSignature !== row.target_signature
      )
        continue;
      const quote = outcomeValueQuoteSchema.safeParse({
        min: row.estimated_sale_price,
        max: row.estimated_sale_price,
        currency: row.currency,
        matching: outcome.matching,
        provenance: {
          kind: 'market-observation',
          reference,
          recordedAt: evidence.source.capturedAt,
          notes: 'Complete comparable asking-price cohort; not confirmed sales',
        },
        market: {
          league: model.league,
          observedAt: evidence.source.capturedAt,
          expiresAt: new Date(
            Math.min(expires, observed + maximumAgeMs),
          ).toISOString(),
          coverage: 'complete',
          independentSellers: evidence.source.sampleSize,
        },
      });
      if (quote.success) valuations[outcome.id] = quote.data;
    }
  }
  return {
    prices: { ...prices, ...model.prices },
    valuations: { ...valuations, ...model.valuations },
  };
}

export type CraftAnalysisOptions = {
  repository: CraftAnalysisRepository;
  recipes: Repositories['recipes'];
  leagues: Repositories['leagues'];
  maximumQuoteAgeMs: () => Promise<number>;
  clock?: () => Date;
  runWorker?: boolean;
  onWorkerError?: (error: unknown) => void;
};

export function createCraftAnalysisService(options: CraftAnalysisOptions) {
  const now = options.clock ?? (() => new Date());
  const shutdown = new AbortController();
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unlisten: Promise<() => Promise<void>> | undefined;
  async function context(recipeId: string, leagueName?: string) {
    const recipe = await options.recipes.findById(recipeId);
    if (!recipe || !recipe.active)
      throw new DomainError('PERSISTENCE_NOT_FOUND');
    const definition = validateRecipeDocument(recipe.definition);
    const league = leagueName
      ? ((await options.leagues.list()).find(
          (l) =>
            l.gggId === leagueName && l.game === 'poe1' && l.realm === 'pc',
        ) ?? null)
      : await options.leagues.findCurrent();
    if (leagueName && !league) throw new DomainError('MARKET_QUERY_INVALID');
    return { recipe, definition, league };
  }
  async function resolvedInput(
    model: CraftModelRecord,
  ): Promise<OutcomeAnalysisInput> {
    const at = now();
    const evidence = resolveCraftAnalysisEvidence(
      model,
      await options.repository.readValuationCandidates(model.leagueId),
      at,
      await options.maximumQuoteAgeMs(),
    );
    return outcomeAnalysisInputSchema.parse({
      model: model.model,
      currency: model.currency,
      league: model.league,
      now: at.toISOString(),
      ...evidence,
    });
  }
  async function drain() {
    await options.repository.withWorker(async (worker, disconnected) => {
      const signal = AbortSignal.any([shutdown.signal, disconnected]);
      while (!signal.aborted) {
        const job = await worker.claim();
        if (!job) return;
        const cancelled = new AbortController();
        let lastProgress = -1;
        let lastCheckpoint = 0;
        const deadline = AbortSignal.timeout(30_000);
        try {
          const result = await simulateCraftingRisk(job.request, {
            signal: AbortSignal.any([signal, cancelled.signal, deadline]),
            async onProgress(progress) {
              const percent = Math.min(
                99,
                Math.floor((progress.completed / progress.total) * 100),
              );
              if (
                percent === lastProgress &&
                Date.now() - lastCheckpoint < 100 &&
                !signal.aborted
              )
                return;
              lastCheckpoint = Date.now();
              lastProgress = percent;
              if (await worker.progress(job.id, percent)) cancelled.abort();
            },
          });
          const stopped =
            signal.aborted || cancelled.signal.aborted || deadline.aborted;
          await worker.finish(
            job.id,
            deadline.aborted
              ? 'failed'
              : stopped
                ? shutdown.signal.aborted || disconnected.aborted
                  ? 'interrupted'
                  : 'cancelled'
                : 'completed',
            stopped ? null : result,
            deadline.aborted
              ? 'Simulation exceeded the 30 second resource limit'
              : null,
          );
        } catch {
          if (!disconnected.aborted)
            await worker.finish(
              job.id,
              signal.aborted ? 'interrupted' : 'failed',
              null,
              signal.aborted
                ? 'Simulation interrupted'
                : 'Simulation failed; no financial result was published',
            );
        }
      }
    });
  }
  let again = false;
  function kick() {
    if (shutdown.signal.aborted || options.runWorker === false) return;
    if (running) {
      // A job may be enqueued after drain's last empty claim.
      again = true;
      return;
    }
    running = drain()
      .catch((error: unknown) => options.onWorkerError?.(error))
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          kick();
        }
      });
  }
  return {
    start() {
      if (timer || options.runWorker === false) return;
      // shortcut: listener loss uses a 5s fallback; reconnect if lower recovery latency is needed.
      timer = setInterval(kick, 5_000);
      timer.unref();
      unlisten = options.repository.listen(kick, options.onWorkerError);
      unlisten.catch((error: unknown) => options.onWorkerError?.(error));
      kick();
    },
    async close() {
      shutdown.abort();
      if (timer) clearInterval(timer);
      await (
        await unlisten?.catch(() => undefined)
      )?.();
      await running;
    },
    async readAnalysis(
      recipeId: string,
      leagueName: string | undefined,
      canEdit: boolean,
    ): Promise<CraftAnalysis> {
      const { recipe, definition, league } = await context(
        recipeId,
        leagueName,
      );
      const model = league
        ? await options.repository.latestModel(
            recipe.id,
            recipe.contentHash,
            league.id,
          )
        : null;
      const input = model ? await resolvedInput(model) : null;
      const analysis = input ? analyzeOutcomeModel(input) : null;
      return craftAnalysisSchema.parse({
        recipeId: recipe.id,
        recipeHash: recipe.contentHash,
        targetSignature: definition.targetSignature,
        league: league?.gggId ?? null,
        leagueId: league?.id ?? null,
        evaluatedAt: now().toISOString(),
        modelRecord: model,
        embeddedModel: model ? null : (definition.craft.outcomeModel ?? null),
        analysis,
        prices: input?.prices ?? {},
        valuations: input?.valuations ?? {},
        unavailableReasons: !league
          ? ['No current league is selected']
          : !model
            ? [
                definition.craft.outcomeModel
                  ? 'Embedded outcome model available — save a revision to resolve prices and run analysis'
                  : 'EV unavailable — missing outcome probabilities and valuations for this recipe revision',
              ]
            : (analysis?.reasons ?? []),
        canEdit,
      });
    },
    async saveModel(value: unknown) {
      const parsed = craftModelSaveInputSchema.safeParse(value);
      if (!parsed.success) throw new DomainError('CALCULATION_INPUT_INVALID');
      const input = parsed.data;
      for (const quote of [
        ...Object.values(input.prices),
        ...Object.values(input.valuations),
      ]) {
        if (
          !['assumption', 'transaction'].includes(quote.provenance.kind) ||
          quote.market
        )
          throw new DomainError('CALCULATION_INPUT_INVALID');
      }
      const { recipe, definition, league } = await context(
        input.recipeId,
        input.league,
      );
      if (recipe.contentHash !== input.recipeHash)
        throw new DomainError('PERSISTENCE_CONFLICT');
      if (
        input.model.stages.some((stage) =>
          stage.outcomes.some(
            (outcome) =>
              outcome.targetSuccess &&
              outcome.matching.kind === 'exact-target' &&
              outcome.matching.targetSignature !== definition.targetSignature,
          ),
        )
      )
        throw new DomainError('CALCULATION_INPUT_INVALID');
      return options.repository.saveModel(input, {
        leagueId: league!.id,
        targetSignature: definition.targetSignature,
      });
    },
    async createSimulation(value: unknown) {
      const parsed = craftRiskCreateInputSchema.safeParse(value);
      if (!parsed.success) throw new DomainError('CALCULATION_INPUT_INVALID');
      const input = parsed.data;
      const requestHash = craftRequestHash(input);
      const previous = await options.repository.findIdempotentRun(
        input.idempotencyKey,
        requestHash,
      );
      if (previous) return previous;
      const { recipe, league } = await context(input.recipeId, input.league);
      const model = await options.repository.findModel(input.modelId);
      if (
        !model ||
        model.recipeId !== recipe.id ||
        model.recipeHash !== input.recipeHash ||
        recipe.contentHash !== input.recipeHash ||
        model.leagueId !== league!.id
      )
        throw new DomainError('PERSISTENCE_CONFLICT');
      const request = riskSimulationRequestSchema.parse({
        ...input.simulation,
        analysis: await resolvedInput(model),
      });
      const job = await options.repository.createRun({
        model,
        request,
        requestHash,
        idempotencyKey: input.idempotencyKey,
        calculationVersion: outcomeCalculationVersion,
      });
      kick();
      return job;
    },
    async readSimulation(id: string) {
      if (!z.uuid().safeParse(id).success)
        throw new DomainError('MARKET_QUERY_INVALID');
      const result = await options.repository.findRun(id);
      if (!result) throw new DomainError('PERSISTENCE_NOT_FOUND');
      return result;
    },
    async cancelSimulation(id: string) {
      if (!z.uuid().safeParse(id).success)
        throw new DomainError('MARKET_QUERY_INVALID');
      const result = await options.repository.cancelRun(id);
      if (!result) throw new DomainError('PERSISTENCE_NOT_FOUND');
      return result;
    },
  };
}
export type CraftAnalysisService = ReturnType<
  typeof createCraftAnalysisService
>;
