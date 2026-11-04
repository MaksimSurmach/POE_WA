import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DomainError,
  intelligenceMonetaryFingerprint,
  analyzeLiquidity,
  stepOpportunitySignal,
  allocateCapital,
  analyzeOutcomeModel,
  hashMarketQuery,
  validateRecipeDocument,
  outcomeAnalysisInputSchema,
  opportunitySignalSchema,
  liquiditySnapshotSchema,
  capitalCandidateSchema,
  intelligenceRiskOptionSchema,
  type Repositories,
  type Recipe,
  type OutcomeAnalysisInput,
  type IntelligenceSettings,
  type OpportunityEvidence,
  type IntelligenceRiskOption,
} from '@poe-worksmith/domain';
import {
  capitalPlanCreateInputSchema,
  savedCapitalPlanSchema,
  opportunityViewSchema,
} from '@poe-worksmith/contracts';
import type { CraftAnalysisService } from './craftAnalysis.js';
import {
  StaleIntelligenceEvaluation,
  type IntelligenceRepository,
} from './repositories/intelligenceRepository.js';
import type { FactoryRepository } from './repositories/factoryRepository.js';
import { craftRequestHash } from './repositories/craftAnalysisRepository.js';
import {
  matchingRecipeListings,
  type RecipeMarketDependencies,
} from './recipeMarket.js';
import { snapshotPayloadSchema } from './catalogPublisher.js';
import { convertMarketQuote } from './marketCurrency.js';
import {
  verifyEconomySnapshot,
  type MarketEconomyRepository,
  type StoredMarketEconomySnapshot,
} from './marketEconomy.js';

export function assertProductionLeagueWindow(
  league: { startAt: Date | null; endAt: Date | null },
  at: Date,
) {
  if (
    (league.startAt && league.startAt.getTime() > at.getTime()) ||
    (league.endAt && league.endAt.getTime() <= at.getTime())
  )
    throw new DomainError('INTELLIGENCE_LEAGUE_INACTIVE');
}

export { intelligenceMonetaryFingerprint } from '@poe-worksmith/domain';
export function matchingCurrentRisk(
  option: IntelligenceRiskOption,
  input: OutcomeAnalysisInput,
  now: string,
) {
  return (
    intelligenceMonetaryFingerprint(option.request.analysis) ===
      intelligenceMonetaryFingerprint(input) &&
    analyzeOutcomeModel({ ...option.request.analysis, now }).status ===
      'complete'
  );
}
const storedStateSchema = z.object({
  view: opportunityViewSchema,
  evidence: z.unknown(),
  signal: opportunitySignalSchema,
});
export function createIntelligenceService(options: {
  repository: IntelligenceRepository;
  factory: FactoryRepository;
  economy?: MarketEconomyRepository;
  analysis: CraftAnalysisService;
  recipes: Repositories['recipes'];
  leagues: Repositories['leagues'];
  marketDependencies: RecipeMarketDependencies;
  settings: () => Promise<IntelligenceSettings>;
  maximumQuoteAgeMs: () => Promise<number>;
  clock?: () => Date;
  runWorker?: boolean;
  onError?: (error: unknown) => void;
}) {
  const now = () => options.clock?.() ?? new Date();
  let timer: ReturnType<typeof setInterval> | undefined,
    active: Promise<void> | null = null,
    closing = false,
    cursor = 0;
  async function context(leagueName: string, allowHistorical = false) {
    const league = (await options.leagues.list()).find(
      (l) => l.gggId === leagueName && l.game === 'poe1' && l.realm === 'pc',
    );
    if (!league) throw new DomainError('MARKET_QUERY_INVALID');
    const at = now();
    if (!allowHistorical) assertProductionLeagueWindow(league, at);
    const settings = await options.settings(),
      recipes = await options.recipes.listActive();
    return {
      league,
      at,
      settings,
      recipes,
      ownCohorts: new Map<
        string,
        Awaited<ReturnType<FactoryRepository['cohortEvidence']>>
      >(),
      maximumQuoteAgeMs: await options.maximumQuoteAgeMs(),
      exchangeCache: new Map<string, StoredMarketEconomySnapshot | null>(),
      latestExchangeId: options.economy
        ? ((await options.economy.latest(league.gggId, 'Currency'))?.id ?? null)
        : null,
      exchangeAttempts: options.economy
        ? await options.economy.listAttempts()
        : [],
    };
  }
  type Context = Awaited<ReturnType<typeof context>>;
  async function liquidity(recipe: Recipe, ctx: Context) {
    const definition = validateRecipeDocument(recipe.definition);
    const cohort = {
      league: ctx.league.gggId,
      targetSignature: definition.targetSignature,
      currency: 'chaos' as const,
    };
    let own = ctx.ownCohorts.get(cohort.targetSignature);
    if (!own) {
      own = await options.factory.cohortEvidence(
        ctx.league.id,
        cohort.targetSignature,
        ctx.at.toISOString(),
        new Date(
          ctx.at.getTime() - ctx.settings.ownSalesWindowDays * 86400000,
        ).toISOString(),
      );
      ctx.ownCohorts.set(cohort.targetSignature, own);
    }
    const sales = own.sales,
      inventory = own.inventory;
    const snapshots = [];
    try {
      const query = (
        await options.marketDependencies({
          recipe: definition,
          league: ctx.league.gggId,
        })
      ).find((d) => d.kind === 'target')?.query;
      if (query) {
        const queryHash = await hashMarketQuery({
          ...query,
          league: ctx.league.gggId,
        });
        const stored = await options.repository.snapshots(
          queryHash,
          ctx.league.id,
        );
        for (const row of stored) {
          const parsed = snapshotPayloadSchema.safeParse(row.payload);
          if (!parsed.success || row.provider_status !== 200) continue;
          const raw = parsed.data.listings.map((l) => ({
            ...l,
            indexedAt: new Date(l.indexedAt),
          }));
          const matched = matchingRecipeListings(
            query.query,
            raw,
            row.captured_at,
            row.captured_at,
          );
          const foreign = matchingRecipeListings(
            query.query,
            raw.filter((l) => l.price.currency !== 'chaos'),
            row.captured_at,
            row.captured_at,
            'divine',
          );
          let expiry = Math.min(
              row.expires_at.getTime(),
              row.captured_at.getTime() + ctx.maximumQuoteAgeMs,
            ),
            validFx = !raw.some(
              (listing) =>
                !['chaos', 'divine'].includes(listing.price.currency),
            );
          for (const listing of foreign) {
            const originalFx = z
              .record(z.string(), z.unknown())
              .safeParse(listing.item.exchange).data;
            const fxId =
              typeof originalFx?.snapshotId === 'string'
                ? originalFx.snapshotId
                : ctx.latestExchangeId;
            if (!fxId || !options.economy) {
              validFx = false;
              continue;
            }
            if (!ctx.exchangeCache.has(fxId))
              ctx.exchangeCache.set(
                fxId,
                verifyEconomySnapshot(
                  await options.economy.find(fxId),
                  ctx.exchangeAttempts,
                  ctx.at,
                ),
              );
            const source = ctx.exchangeCache.get(fxId) ?? null;
            const verified = source
              ? Date.parse(source.verifiedAt ?? source.capturedAt)
              : NaN;
            if (
              !source ||
              !Number.isFinite(verified) ||
              verified + ctx.maximumQuoteAgeMs <= ctx.at.getTime() ||
              Math.abs(verified - row.captured_at.getTime()) >
                ctx.maximumQuoteAgeMs
            ) {
              validFx = false;
              continue;
            }
            const converted = await convertMarketQuote({
              money: listing.price,
              currency: 'chaos',
              target: { league: ctx.league.gggId },
              capturedAt: row.captured_at.toISOString(),
              exchangeSnapshotId: fxId,
              economy: {
                find: async (id) => (id === source.id ? source : null),
              },
              now: ctx.at.getTime(),
              dataKind: 'observed',
            });
            if (!converted?.exchange) {
              validFx = false;
              continue;
            }
            matched.push({
              ...listing,
              price: converted.money,
              item: {
                ...listing.item,
                currency: 'chaos',
                exchange: converted.exchange,
                originalPrice: listing.price,
              },
            });
            expiry = Math.min(expiry, verified + ctx.maximumQuoteAgeMs);
          }
          for (const listing of matched) {
            const fx = z
              .record(z.string(), z.unknown())
              .safeParse(listing.item.exchange).data;
            if (fx && typeof fx === 'object' && !Array.isArray(fx)) {
              const fxId =
                typeof fx.snapshotId === 'string' ? fx.snapshotId : null;
              if (!fxId || !options.economy) {
                validFx = false;
                continue;
              }
              if (!ctx.exchangeCache.has(fxId))
                ctx.exchangeCache.set(
                  fxId,
                  verifyEconomySnapshot(
                    await options.economy.find(fxId),
                    ctx.exchangeAttempts,
                    ctx.at,
                  ),
                );
              const source = ctx.exchangeCache.get(fxId);
              if (
                !source ||
                source.league !== cohort.league ||
                source.category !== 'Currency' ||
                source.priceBasis !== 'currency-exchange'
              ) {
                validFx = false;
                continue;
              }
              const sourceVerified = Date.parse(
                source.verifiedAt ?? source.capturedAt,
              );
              if (
                !Number.isFinite(sourceVerified) ||
                sourceVerified > ctx.at.getTime() ||
                sourceVerified + ctx.maximumQuoteAgeMs <= ctx.at.getTime()
              ) {
                validFx = false;
                continue;
              }
              const verified =
                typeof fx.verifiedAt === 'string'
                  ? fx.verifiedAt
                  : fx.capturedAt;
              const captured =
                typeof verified === 'string' ? Date.parse(verified) : NaN;
              if (
                fx.league !== cohort.league ||
                !Number.isFinite(captured) ||
                captured > ctx.at.getTime()
              )
                validFx = false;
              else
                expiry = Math.min(
                  expiry,
                  Math.max(captured, sourceVerified) + ctx.maximumQuoteAgeMs,
                );
            }
          }
          const value = liquiditySnapshotSchema.safeParse({
            id: row.dedupe_key,
            cohort,
            queryHash,
            capturedAt: row.captured_at.toISOString(),
            expiresAt: new Date(expiry).toISOString(),
            coverage:
              validFx && matched.length <= 2000
                ? (parsed.data.coverage ?? 'unknown')
                : 'partial',
            sortedSampleComplete: parsed.data.sortedSampleComplete ?? false,
            totalListings: parsed.data.totalResults,
            listings: matched
              .filter((l) => l.price.currency === 'chaos')
              .slice(0, 2000)
              .map((l) => ({
                id: l.id,
                seller: l.account,
                askChaos: l.price.amount,
                indexedAt: l.indexedAt.toISOString(),
              })),
          });
          if (value.success) snapshots.push(value.data);
        }
      }
    } catch (error) {
      options.onError?.(error);
    }
    const input = {
      cohort,
      now: ctx.at.toISOString(),
      snapshots,
      ownSales: sales.slice(0, 10000),
      ownInventory: inventory.slice(0, 10000),
      ownCoverageComplete: own.complete,
      settings: ctx.settings,
    };
    const assessment = analyzeLiquidity(input);
    if (!own.complete)
      assessment.reasons.push(
        `Own cohort replay reached a limit: ${own.replayedBatches}/${own.maximumBatches} batches; at most ${own.maximumRows} sales/inventory rows. Older unsold items were included until this explicit limit.`,
      );
    return {
      assessment,
      input,
      exchangeEvidence: [...ctx.exchangeCache.values()].filter(
        (value) => value !== null,
      ),
      ownCoverage: {
        complete: own.complete,
        replayedBatches: own.replayedBatches,
        maximumBatches: own.maximumBatches,
        maximumRows: own.maximumRows,
      },
    };
  }
  async function evaluate(recipe: Recipe, ctx: Context) {
    const current = await options.analysis.readAnalysis(
      recipe.id,
      ctx.league.gggId,
      true,
    );
    const primary = await liquidity(recipe, ctx);
    const model = current.modelRecord;
    const analysisInput = model
      ? outcomeAnalysisInputSchema.parse({
          model: model.model,
          currency: model.currency,
          league: ctx.league.gggId,
          now: ctx.at.toISOString(),
          prices: current.prices,
          valuations: current.valuations,
        })
      : null;
    const riskOptions: IntelligenceRiskOption[] = [];
    if (model && analysisInput && current.analysis?.status === 'complete')
      for (const run of await options.repository.risks(
        recipe.id,
        recipe.contentHash,
        ctx.league.id,
        model.id,
      )) {
        if (!run.result) continue;
        const option = intelligenceRiskOptionSchema.parse({
          id: run.id,
          recipeId: recipe.id,
          recipeHash: recipe.contentHash,
          targetSignature: current.targetSignature,
          league: ctx.league.gggId,
          createdAt: run.finishedAt ?? run.createdAt,
          request: run.request,
          result: run.result,
        });
        if (matchingCurrentRisk(option, analysisInput, ctx.at.toISOString()))
          riskOptions.push(option);
      }
    const additional: Awaited<ReturnType<typeof liquidity>>[] = [];
    const signatures = new Set(
      model?.model.stages.flatMap((s) =>
        s.outcomes.flatMap((o) =>
          o.sellable &&
          o.matching.kind === 'exact-target' &&
          o.matching.targetSignature !== current.targetSignature
            ? [o.matching.targetSignature]
            : [],
        ),
      ) ?? [],
    );
    for (const signature of [...signatures].slice(0, 8)) {
      const comparable = ctx.recipes.find(
        (r) =>
          validateRecipeDocument(r.definition).targetSignature === signature,
      );
      if (comparable) additional.push(await liquidity(comparable, ctx));
    }
    const evidence: OpportunityEvidence = {
      recipeId: recipe.id,
      recipeHash: recipe.contentHash,
      cohort: primary.assessment.cohort,
      observationId: primary.assessment.snapshotId,
      observedAt: primary.assessment.observedAt,
      analysisInput,
      analysis: current.analysis,
      risk: riskOptions[0] ?? null,
      liquidity: primary.assessment,
      additionalLiquidities: additional.map((v) => v.assessment),
    };
    const key = craftRequestHash({
      recipeId: recipe.id,
      recipeHash: recipe.contentHash,
      leagueId: ctx.league.id,
    });
    const stored = await options.repository.updateSignal(
      {
        key,
        recipeId: recipe.id,
        recipeHash: recipe.contentHash,
        leagueId: ctx.league.id,
        targetSignature: current.targetSignature,
        evaluatedAt: ctx.at.toISOString(),
        observedAt: evidence.observedAt,
      },
      (previous) => {
        const parsed = storedStateSchema.safeParse(previous);
        const signal = stepOpportunitySignal({
          previous: parsed.success ? parsed.data.signal : null,
          evidence,
          settings: ctx.settings,
          now: ctx.at.toISOString(),
        });
        const view = opportunityViewSchema.parse({
          recipeId: recipe.id,
          title: recipe.title,
          category: recipe.category,
          targetSignature: current.targetSignature,
          signal,
          liquidity: primary.assessment,
          availableRiskOptions: riskOptions.map((o) => ({
            id: o.id,
            currency: o.result.currency,
            objective: o.result.objective,
            p90: o.result.costQuantiles?.p90 ?? null,
            p95: o.result.costQuantiles?.p95 ?? null,
            expectedProfit: o.result.meanProfit,
          })),
          reasons: [...current.unavailableReasons, ...signal.reasons],
        });
        const document = {
          view,
          signal,
          evidence,
          sourceInputs: {
            liquidity: primary.input,
            ownCoverage: primary.ownCoverage,
            exchangeEvidence: primary.exchangeEvidence,
            additional: additional.map((v) => v.input),
            riskOptions,
            settings: ctx.settings,
          },
        };
        return {
          document,
          emit: signal.emit,
          evidenceHash: craftRequestHash({
            riskId: evidence.risk?.id,
            settings: ctx.settings,
            state: signal.state,
            triggers: signal.triggers,
            metrics: signal.metrics,
            reasons: signal.reasons,
            observationId: evidence.observationId,
            modelId: model?.id,
            monetary: analysisInput
              ? intelligenceMonetaryFingerprint(analysisInput)
              : null,
          }),
        };
      },
    );
    const candidate =
      analysisInput && current.analysis
        ? capitalCandidateSchema.parse({
            recipeId: recipe.id,
            recipeHash: recipe.contentHash,
            title: recipe.title,
            category: recipe.category,
            targetSignature: current.targetSignature,
            league: ctx.league.gggId,
            signal: stored.signal,
            analysisInput,
            analysis: current.analysis,
            liquidity: primary.assessment,
            additionalLiquidities: additional.map((v) => v.assessment),
            options: riskOptions,
          })
        : null;
    return { view: stored.view, candidate, key, evidence: stored };
  }
  async function feed(league: string, ids?: string[], categories?: string[]) {
    // Rebuild the entire feed after a race: a newer signal must never be
    // paired with candidates or policy captured by an older evaluation.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await feedOnce(league, ids, categories);
      } catch (error) {
        if (!(error instanceof StaleIntelligenceEvaluation)) throw error;
      }
    }
    throw new DomainError('INTELLIGENCE_RETRY_LATER');
  }
  async function feedOnce(
    league: string,
    ids?: string[],
    categories?: string[],
  ) {
    const ctx = await context(league);
    const selected = ctx.recipes.filter(
      (r) =>
        (!ids || ids.includes(r.id)) &&
        (!categories || categories.includes(r.category)),
    );
    const entries = [];
    for (const recipe of selected.slice(0, 50)) {
      if (closing) break;
      entries.push(await evaluate(recipe, ctx));
    }
    const currentSettings = await options.settings();
    const currentQuoteAge = await options.maximumQuoteAgeMs();
    if (
      craftRequestHash(currentSettings) !== craftRequestHash(ctx.settings) ||
      currentQuoteAge !== ctx.maximumQuoteAgeMs
    )
      throw new StaleIntelligenceEvaluation();
    const decisionAt = now();
    assertProductionLeagueWindow(ctx.league, decisionAt);
    return { ctx, entries, total: selected.length, decisionAt };
  }
  function kick() {
    if (closing || active || options.runWorker === false) return;
    active = options.repository
      .withRefreshLease(async () => {
        const league = await options.leagues.findCurrent();
        if (!league) return;
        const ctx = await context(league.gggId);
        const selection = ctx.recipes.slice(cursor, cursor + 10);
        cursor = cursor + 10 >= ctx.recipes.length ? 0 : cursor + 10;
        for (const recipe of selection) {
          if (closing) break;
          try {
            await evaluate(recipe, ctx);
          } catch (error) {
            // Another evaluator already published fresher evidence for this
            // recipe. Continue the bounded worker slice without overwriting it.
            if (!(error instanceof StaleIntelligenceEvaluation)) throw error;
          }
        }
      })
      .catch((e) => options.onError?.(e))
      .finally(() => {
        active = null;
      });
  }
  return {
    start() {
      if (timer || options.runWorker === false) return;
      timer = setInterval(kick, 60_000);
      timer.unref();
      kick();
    },
    async close() {
      closing = true;
      if (timer) clearInterval(timer);
      await active;
    },
    async opportunities(league: string) {
      const result = await feed(league);
      return {
        league,
        asOf: result.ctx.at.toISOString(),
        opportunities: result.entries.map((e) => e.view),
        coverage: {
          complete: result.total === result.entries.length,
          totalRecipes: result.total,
          includedRecipes: result.entries.length,
        },
      };
    },
    async opportunity(recipeId: string, league: string) {
      const result = await feed(league, [recipeId]);
      if (!result.entries[0]) throw new DomainError('PERSISTENCE_NOT_FOUND');
      return result.entries[0].view;
    },
    async history(recipeId: string, league: string) {
      const ctx = await context(league, true),
        recipe = ctx.recipes.find((r) => r.id === recipeId);
      if (!recipe) throw new DomainError('PERSISTENCE_NOT_FOUND');
      const key = craftRequestHash({
        recipeId,
        recipeHash: recipe.contentHash,
        leagueId: ctx.league.id,
      });
      const history = await options.repository.history(key);
      return {
        decisions: history.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          signal: storedStateSchema.parse(row.document).signal,
        })),
      };
    },
    async allocate(raw: unknown) {
      const parsed = capitalPlanCreateInputSchema.safeParse(raw);
      if (!parsed.success) throw new DomainError('CALCULATION_INPUT_INVALID');
      const { idempotencyKey, ...request } = parsed.data;
      const hash = craftRequestHash(request);
      const prior = await options.repository.findPlanRetry(
        idempotencyKey,
        hash,
      );
      if (prior)
        return savedCapitalPlanSchema.parse((prior as { view: unknown }).view);
      const result = await feed(
        request.league,
        request.recipeIds,
        request.categories,
      );
      const candidates = result.entries.flatMap((e) =>
        e.candidate ? [e.candidate] : [],
      );
      const plan = allocateCapital({
        request,
        candidates,
        settings: result.ctx.settings,
        now: result.decisionAt.toISOString(),
      });
      const missing = (request.recipeIds ?? []).filter(
        (id) => !result.ctx.recipes.some((recipe) => recipe.id === id),
      );
      for (const scenario of plan.scenarios) {
        for (const entry of result.entries.filter((entry) => !entry.candidate))
          scenario.watchlist.push({
            recipeId: entry.view.recipeId,
            reasons: entry.view.reasons.length
              ? entry.view.reasons
              : ['Outcome model or probabilities unavailable'],
          });
        for (const recipeId of missing)
          scenario.watchlist.push({
            recipeId,
            reasons: ['Requested recipe is unavailable in the active catalog'],
          });
      }
      if (result.total > result.entries.length)
        for (const scenario of plan.scenarios)
          scenario.limitations.push(
            'Candidate coverage is capped at 50 recipes; use recipe restrictions to inspect other recipes.',
          );
      const view = savedCapitalPlanSchema.parse({
        id: randomUUID(),
        createdAt: now().toISOString(),
        plan,
      });
      const stored = await options.repository.savePlan({
        id: view.id,
        leagueId: result.ctx.league.id,
        key: idempotencyKey,
        hash,
        document: {
          view,
          candidates,
          settings: result.ctx.settings,
          sources: result.entries.map((e) => e.evidence),
        },
      });
      return savedCapitalPlanSchema.parse((stored as { view: unknown }).view);
    },
    async plan(id: string) {
      if (!z.uuid().safeParse(id).success)
        throw new DomainError('MARKET_QUERY_INVALID');
      const record = await options.repository.findPlan(id);
      if (!record) throw new DomainError('PERSISTENCE_NOT_FOUND');
      return savedCapitalPlanSchema.parse((record as { view: unknown }).view);
    },
  };
}
export type IntelligenceService = ReturnType<typeof createIntelligenceService>;
