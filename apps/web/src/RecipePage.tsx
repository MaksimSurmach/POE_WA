import { MaterialPlan } from './MaterialPlan.js';
import { planScope } from './materialPlanModel.js';
import { StepCheck } from './StepCheck.js';
import { FavoriteButton } from './Watchlist.js';
import { formatTimestamp } from './dateTime.js';
import { Button, TableSurface } from './ui.js';
import {
  domainErrorDefinitions,
  type CatalogEntry,
  type CatalogResponse,
  type MarketReadiness as MarketReadinessView,
  type RecipeResponse,
  type TrendRange,
} from '@poe-worksmith/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { WorkspaceLink as Link } from './workspaceNavigation.js';

import {
  Money,
  ProfitBadge,
  StatusPanel,
  economicClass,
} from './components.js';
import { evidenceRank, formatMarginPercent } from './catalog.js';
import { ApiClientError, createApiClient } from './apiClient.js';
import { ItemTooltip } from './ItemTooltip.js';
import { RecipeTrendPanel, trendRanges } from './MarketTrendsPage.js';
import { CraftRiskSection } from './CraftRiskSection.js';
import {
  isSingleSellerHypothesis,
  MarketReadiness,
} from './MarketReadiness.js';

const apiClient = createApiClient('', (url, options) =>
  fetch(url, { ...options, signal: AbortSignal.timeout(15_000) }),
);

export function RecipePage({
  selectedRecipeId,
}: { selectedRecipeId?: string } = {}) {
  const route = useParams();
  const recipeId = selectedRecipeId ?? route.recipeId;
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'recipe';
  const [response, setResponse] = useState<RecipeResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const requestedRange = params.get('range') as TrendRange;
  const trendRange = trendRanges.includes(requestedRange)
    ? requestedRange
    : '24h';
  function setTrendRange(range: TrendRange) {
    const next = new URLSearchParams(params);
    next.set('range', range);
    setParams(next, { replace: true });
  }
  const [catalogState, setCatalogState] = useState<
    'loading' | 'ready' | 'failed'
  >('loading');
  const [revision, setRevision] = useState(0);
  const [catalogEntries, setCatalogEntries] = useState<CatalogEntry[]>([]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let catalog: CatalogResponse | null = null;
    setCatalogState('loading');
    setCatalogEntries([]);
    setResponse(null);
    setLoadError(false);
    if (!recipeId) {
      setLoadError(true);
      return () => {
        active = false;
      };
    }
    const id = recipeId;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        const recipe = await apiClient.getRecipe(id);
        if (!active) return;
        setResponse(recipe);
        setLoadError(false);
        if (
          recipe.data &&
          shouldRefreshMethodComparison(
            catalog,
            recipe.data.targetSignature,
            recipe.publishedAt,
          )
        ) {
          catalog = await apiClient.getCatalog().catch(() => null);
          if (active) {
            setCatalogEntries(catalog?.data?.entries ?? []);
            setCatalogState(catalog?.data ? 'ready' : 'failed');
          }
        }
      } catch (error) {
        if (active) {
          setCatalogState('failed');
          catalog = null;
          setCatalogEntries([]);
          if (error instanceof ApiClientError && error.status === 404)
            setResponse(null);
          setLoadError(true);
        }
      } finally {
        inFlight = false;
      }
    }
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30_000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [recipeId, revision]);

  if (!response?.data)
    return (
      <RecipeMessage
        title={response || loadError ? 'Рецепт недоступен' : 'Загрузка рецепта'}
      />
    );

  const detail = response.data;
  const { evaluation, recipe } = detail;
  const method = detail.method;
  const targetMods = detail.presentation.target.modifiers;
  const sourceLeague = method.priceSources[0]?.league;
  const selectedLeague = params.get('league');
  const wrongLeague = Boolean(
    sourceLeague && selectedLeague && sourceLeague !== selectedLeague,
  );
  const leagueWarning = wrongLeague ? (
    <StatusPanel tone="warning" title="Лига источника отличается">
      Выбрана лига {selectedLeague}, а API вернул цены для {sourceLeague}. Цены
      и расчёты скрыты. Инструкции доступны независимо от лиги.{' '}
      <Link
        to={`/recipes/${encodeURIComponent(recipe.id)}?view=${encodeURIComponent(view)}&league=${encodeURIComponent(sourceLeague!)}`}
      >
        Открыть данные лиги {sourceLeague}
      </Link>
    </StatusPanel>
  ) : null;

  if (view === 'budget' || view === 'materials')
    return (
      <article className="recipe-detail">
        <h1>{recipe.title}</h1>
        {wrongLeague ? (
          leagueWarning
        ) : (
          <MaterialPlan
            key={planScope(
              detail,
              sourceLeague ?? selectedLeague ?? 'Лига неизвестна',
            )}
            detail={detail}
            budget={view === 'budget'}
            sourceUnavailable={loadError}
          />
        )}
      </article>
    );
  const show = (...views: string[]) =>
    views.includes(view) || !['item', 'steps', 'methods'].includes(view);

  const prices =
    detail.snapshot?.listings
      .map((l) => l.price)
      .filter((p) => p.currency === evaluation.estimatedSalePrice?.currency)
      .sort((a, b) => a.amount - b.amount) ?? [];
  const middle = Math.floor(prices.length / 2);
  const median = prices.length
    ? {
        currency: prices[middle]!.currency,
        amount:
          prices.length % 2
            ? prices[middle]!.amount
            : (prices[middle - 1]!.amount + prices[middle]!.amount) / 2,
      }
    : null;

  return (
    <article className="recipe-detail recipe-detail--compact">
      {leagueWarning}
      <div className="recipe-detail__actions">
        {view === 'item' ? (
          <Link to={`/recipes/${encodeURIComponent(recipe.id)}?view=recipe`}>
            Открыть рецепт
          </Link>
        ) : null}
        <FavoriteButton recipeId={recipe.id} />
        <Link
          to={`/market?recipe=${encodeURIComponent(recipe.id)}&view=history`}
        >
          Рынок
        </Link>
        <Link to={`/?recipe=${encodeURIComponent(recipe.id)}&view=budget`}>
          Бюджет
        </Link>
        <Link to={`/recipes/${encodeURIComponent(recipe.id)}?view=materials`}>
          Материалы
        </Link>
        <Link className="back-link" to="/recipes">
          ‹ Рецепты
        </Link>
        <Link
          className="back-link"
          to={`/factory?recipe=${encodeURIComponent(recipe.id)}`}
        >
          Создать партию →
        </Link>
      </div>
      {loadError ? (
        <p role="status" className="recipe-warning">
          Не удалось обновить цены. Показаны последние загруженные данные.
        </p>
      ) : null}
      <header className="recipe-detail__header">
        <div className="recipe-detail__identity">
          <ItemTooltip item={detail.presentation.target} />
          <div>
            <h1>{recipe.title}</h1>
            <span className="recipe-detail__type">
              {recipe.category.replaceAll('-', ' ')} · Patch{' '}
              {detail.gameVersion}
            </span>
          </div>
        </div>
        {!wrongLeague && detail.targetTradeUrl ? (
          <a
            className="buy-base"
            href={detail.targetTradeUrl}
            rel="noreferrer"
            target="_blank"
          >
            Найти готовый предмет ↗
          </a>
        ) : null}
        {!wrongLeague && detail.baseTradeUrl ? (
          <a
            className="buy-base"
            href={detail.baseTradeUrl}
            rel="noreferrer"
            target="_blank"
          >
            Buy {detail.base.name} ↗
          </a>
        ) : null}
      </header>

      {!wrongLeague ? (
        <>
          <div className="recipe-economics" aria-label="Current economics">
            <RecipeMarketStats readiness={detail.readiness} />
            {evaluation.expectedCraftCost ? (
              <span>
                Оценка средних затрат{' '}
                <strong>
                  <Money price={evaluation.expectedCraftCost} />
                </strong>
              </span>
            ) : null}
            <span>
              Цена сопоставимого объявления{' '}
              <strong>
                <Money
                  price={
                    evaluation.estimatedSalePrice ??
                    (detail.readiness?.fresh
                      ? (detail.readiness.currentAskRange?.min ??
                        detail.marketActivity?.observedAskSample?.[0])
                      : null) ??
                    null
                  }
                />
              </strong>
            </span>
            {evaluation.profit ? (
              <span>
                Разница с asking price{' '}
                <strong>
                  {evaluation.profit ? (
                    <ProfitBadge {...evaluation.profit} />
                  ) : (
                    'Not estimated'
                  )}
                </strong>
              </span>
            ) : null}
            {evaluation.marginPercent !== null ? (
              <span>
                ROI{' '}
                <strong className={economicClass(evaluation.marginPercent)}>
                  {evaluation.marginPercent === null
                    ? 'Not estimated'
                    : formatMarginPercent(evaluation.marginPercent)}
                </strong>
              </span>
            ) : null}
            <span>
              Метод крафта<strong>{method.name}</strong>
            </span>
          </div>
          {evaluation.profitBlockedReason ? (
            <p className="recipe-warning">
              Profit and ROI withheld: {evaluation.profitBlockedReason}
            </p>
          ) : null}
          {evaluation.expectedCraftCost ? (
            <p>
              Break-even ask at mean cost{' '}
              <Money price={evaluation.expectedCraftCost} />
            </p>
          ) : null}
          <details className="economics-help">
            <summary>Как рассчитаны затраты и разница с ask</summary>
            <p className="catalog-price-note">
              ROI = (цена объявления − средние затраты) ÷ средние затраты ×
              100%. При затратах 10 div и цене объявления 12 div разница
              составляет 2 div, ROI — 20%. Это оценка по asking price, не
              реализованная прибыль. Средние затраты не гарантируют бюджет
              отдельного крафта.
            </p>
          </details>

          {show('methods') ? (
            <MethodsForTarget
              entries={catalogEntries}
              targetSignature={detail.targetSignature}
            />
          ) : null}
          {show('methods') && catalogState !== 'ready' ? (
            <StatusPanel
              tone={catalogState === 'failed' ? 'danger' : 'info'}
              title={
                catalogState === 'failed'
                  ? 'Сравнение методов недоступно'
                  : 'Загрузка методов'
              }
            >
              {catalogState === 'failed' ? (
                <Button onClick={() => setRevision((value) => value + 1)}>
                  Повторить
                </Button>
              ) : null}
            </StatusPanel>
          ) : null}
          {view === 'methods' &&
          catalogState === 'ready' &&
          catalogEntries.filter(
            ({ recipe: candidate }) =>
              candidate.targetSignature === detail.targetSignature,
          ).length < 2 ? (
            <StatusPanel tone="info" title="Нет совместимых методов">
              Для этой цели нет второго сопоставимого метода. Совпадения
              названий недостаточно.
            </StatusPanel>
          ) : null}
        </>
      ) : null}

      {show('item') ? (
        <DetailSection title="База и цель">
          <ItemTooltip item={detail.presentation.base} />
          <p className="base-requirements">
            {detail.base.name} · {detail.base.requirements.join(' · ')}
          </p>
          {(['prefix', 'suffix', 'implicit', 'enchant', 'other'] as const).map(
            (group) =>
              targetMods.some((m) => m.generationType === group) ? (
                <p className="base-requirements" key={group}>
                  {group}:{' '}
                  {targetMods
                    .filter((m) => m.generationType === group)
                    .map((m) => m.label)
                    .join(' · ') || 'None required'}
                </p>
              ) : null,
          )}
        </DetailSection>
      ) : null}
      {method && show('steps') ? (
        <DetailSection title={method.name}>
          {evaluation.status === 'stale' ? (
            <p className="recipe-warning">
              Material prices below are past observations. Refresh prices before
              using them as a current crafting budget.
            </p>
          ) : null}
          {!wrongLeague ? (
            <p>
              Starting base: <Money price={method.baseCost} />.
              {method.expectedBases == null
                ? ' Expected base consumption is not verified.'
                : ` ${method.expectedBases} expected bases per finished item.`}{' '}
              Material prices are shown per use below.
            </p>
          ) : null}
          {!method.steps.length ? (
            <StatusPanel
              tone="info"
              title="Нет проверенной последовательности шагов"
            >
              Метод пока не содержит подробных действий. Проверьте источник
              рецепта.
            </StatusPanel>
          ) : null}
          <ol className="craft-steps">
            {method.steps.map((step) => {
              const execution = method.expectedExecutions.find(
                ({ stepId }) => stepId === step.id,
              );
              return (
                <li key={step.id}>
                  <StepCheck
                    recipeId={`${recipe.id}:${detail.gameVersion}:${method.id}:${sourceLeague ?? ''}`}
                    stepId={step.id}
                    stepName={step.title}
                  />
                  <strong>{step.action}</strong>
                  <span>
                    {step.materials
                      .map(
                        (material) =>
                          `${material.quantityPerAttempt ?? '?'} × ${material.name}`,
                      )
                      .join(' · ')}
                  </span>
                  {!wrongLeague ? (
                    <div className="recipe-ingredients">
                      {step.materials.map((material) => {
                        const art = detail.presentation.materials.find(
                          (m) => m.canonicalId === material.itemId,
                        );
                        return (
                          <span
                            className="recipe-ingredient"
                            key={material.itemId}
                          >
                            {art ? (
                              <ItemTooltip
                                item={{
                                  canonicalId: art.canonicalId,
                                  iconUrl: art.iconUrl,
                                  itemClass: art.itemClass,
                                  itemLevel: null,
                                  modifiers: [],
                                  name: art.name,
                                  properties: [],
                                  rarity: 'normal',
                                  role: 'material',
                                }}
                              />
                            ) : null}
                            <span>
                              {material.name}:{' '}
                              <Money price={material.unitPrice} /> each ·{' '}
                              <Money price={material.costPerAttempt} /> per
                              execution
                              {execution && material.costPerAttempt ? (
                                <>
                                  {' '}
                                  · {execution.count.toLocaleString()}{' '}
                                  executions ={' '}
                                  <Money
                                    price={{
                                      currency:
                                        material.costPerAttempt.currency,
                                      amount:
                                        material.costPerAttempt.amount *
                                        execution.count,
                                    }}
                                  />{' '}
                                  expected total
                                </>
                              ) : null}
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                  <small>
                    {step.success
                      ? `${(step.success.probability * 100).toPrecision(3)}% chance`
                      : ''}
                    {execution
                      ? `${step.success ? ' · ' : ''}about ${execution.count.toLocaleString()} uses per item`
                      : ' · Expected uses: Not estimated'}
                  </small>
                  <small>
                    Success: {step.continueWhen} · Failure/recovery:{' '}
                    {step.failureAction}
                  </small>
                </li>
              );
            })}
          </ol>
          {method.evidence ? (
            <a
              className="craft-evidence"
              href={method.evidence.url}
              rel="noreferrer"
              target="_blank"
            >
              Craft of Exile
            </a>
          ) : null}
        </DetailSection>
      ) : null}

      {!wrongLeague && show('item') ? (
        <DetailSection title="Источники цен" collapsed>
          <p>
            Starting base: <Money price={method.baseCost} /> · Expected bases
            per finished item: {method.expectedBases ?? 'Not estimated'}
          </p>
          {method.priceSources.map((source) => (
            <p key={source.itemId}>
              {source.itemId.replaceAll('-', ' ')} · {source.source} ·{' '}
              {source.league} · {source.currency} ·{' '}
              {source.priceBasis === 'economy-estimate'
                ? 'Economy estimate'
                : source.bulkSupported === false
                  ? 'Unit ask (bulk stock unverified)'
                  : 'Asking price'}{' '}
              ·{' '}
              {source.sortedSampleComplete
                ? `Available ask sample: 20/${source.totalResults ?? 'unknown'} offers · `
                : ''}
              <time dateTime={source.capturedAt}>
                {formatTimestamp(source.capturedAt)}
              </time>
              {source.verifiedAt && source.verifiedAt !== source.capturedAt ? (
                <>
                  {' '}
                  · Rechecked{' '}
                  <time dateTime={source.verifiedAt}>
                    {formatTimestamp(source.verifiedAt)}
                  </time>
                </>
              ) : null}
            </p>
          ))}
          <p>
            {detail.snapshot
              ? `${detail.snapshot.listings.length} verified sellers · ${detail.snapshot.coverage ?? 'unknown'} search coverage${detail.snapshot.sortedPageComplete ? ' (complete lowest-price page)' : detail.snapshot.sortedSampleComplete ? ` (sorted price sample: 20/${detail.snapshot.totalResults} offers)` : ''}${detail.snapshot.listings.length > 0 && detail.snapshot.listings.length <= 2 ? ' · Thin market' : ''} · ${formatTimestamp(detail.snapshot.capturedAt)}`
              : detail.marketActivity?.observedAskSample?.length
                ? 'See observed asking prices below.'
                : method.marketStatus === 'empty'
                  ? 'No verified comparable asking prices found.'
                  : 'Comparable market data unavailable.'}
          </p>
          <p>
            Median verified ask (observed sample): <Money price={median} />
          </p>
          <div className="recipe-ingredients">
            {detail.snapshot?.listings.slice(0, 5).map((listing) => (
              <span className="recipe-ingredient" key={listing.id}>
                {listing.itemPreview ? (
                  <ItemTooltip item={listing.itemPreview} />
                ) : null}
                <Money price={listing.price} />
              </span>
            ))}
          </div>
        </DetailSection>
      ) : null}
      {!wrongLeague && detail.readiness && show('item') ? (
        <DetailSection title="Готовность данных" collapsed>
          <MarketReadiness readiness={detail.readiness} />
        </DetailSection>
      ) : null}
      {!wrongLeague && detail.marketActivity && show('item') ? (
        <DetailSection title="Активность объявлений">
          <p>Inferred from listings, not sales.</p>
          <p>
            {detail.marketActivity.active === null
              ? 'Current supply unavailable: capture coverage or freshness is insufficient.'
              : `${detail.marketActivity.active} active listings · ${detail.marketActivity.distinctSellers} sellers`}
          </p>
          {detail.marketActivity.observedAskSample?.length ? (
            <div>
              <p>Lowest observed asks in this capture</p>
              <ul>
                {detail.marketActivity.observedAskSample.map((price, index) => (
                  <li key={index}>
                    <Money price={price} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {detail.marketActivity.staleAskCount ? (
            <p>
              {detail.marketActivity.staleAskCount} asks observed unchanged for
              at least seven days. They are still included in the observed
              prices.
              {detail.marketActivity.observedFloorWithoutStaleAsks != null ? (
                <>
                  {' '}
                  Lowest other observed ask:{' '}
                  <Money
                    price={{
                      amount:
                        detail.marketActivity.observedFloorWithoutStaleAsks,
                      currency: 'chaos',
                    }}
                  />
                  .
                </>
              ) : (
                ' Every priced observation in this capture is stale.'
              )}
            </p>
          ) : null}
          <p>
            Last 72 h: {detail.marketActivity.repriced72h} repriced ·{' '}
            {detail.marketActivity.inferredExits72h === null
              ? 'insufficient evidence for inferred exits'
              : `${detail.marketActivity.inferredExits72h} inferred exits`}{' '}
            · {detail.marketActivity.uncertainExits72h} uncertain exits
          </p>
          {detail.marketActivity.recentExitAsk ? (
            <p>
              Median last ask of inferred exits:{' '}
              <Money price={detail.marketActivity.recentExitAsk} />
            </p>
          ) : null}
          <p>
            <Link to="/factory">Ваши подтверждённые продажи в мастерской</Link>
          </p>
        </DetailSection>
      ) : null}
      {!wrongLeague && show('item') ? (
        <DetailSection title="История цен">
          <RecipeTrendPanel
            onRangeChange={setTrendRange}
            range={trendRange}
            recipeId={recipe.id}
          />
          <Link
            className="recipe-link"
            to={`/market?recipe=${encodeURIComponent(recipe.id)}&range=${trendRange}`}
          >
            Compare in market trends ›
          </Link>
        </DetailSection>
      ) : null}
      {!wrongLeague && show('item') ? (
        <details className="detail-section">
          <summary>Расчёт ожидаемой стоимости и риска</summary>
          <CraftRiskSection key={recipe.id} recipeId={recipe.id} />
        </details>
      ) : null}
      {detail.uncertainties.length ? (
        <details className="detail-section">
          <summary>Ограничения крафта и оценок</summary>
          <ul>
            {detail.uncertainties.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

function RecipeMessage({ title }: { title: string }) {
  return (
    <>
      <Link className="back-link" to="/recipes">
        ‹ Рецепты
      </Link>
      <StatusPanel
        tone={title === 'Загрузка рецепта' ? 'info' : 'danger'}
        title={title}
      />
    </>
  );
}

function DetailSection({
  children,
  title,
  collapsed = false,
}: {
  children: ReactNode;
  title: string;
  collapsed?: boolean;
}) {
  if (collapsed)
    return (
      <details className="detail-section">
        <summary>{title}</summary>
        {children}
      </details>
    );
  return (
    <section
      className={`detail-section${title === 'База и цель' ? ' base-target' : ''}`}
    >
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function shouldRefreshMethodComparison(
  catalog: CatalogResponse | null,
  targetSignature: string,
  publishedAt: string | null,
) {
  if (!catalog?.data || catalog.publishedAt !== publishedAt) return true;
  return (
    catalog.data.entries.filter(
      ({ recipe }) => recipe.targetSignature === targetSignature,
    ).length > 1
  );
}

export function MethodsForTarget({
  entries,
  targetSignature,
}: {
  entries: CatalogEntry[];
  targetSignature: string;
}) {
  const methods = entries
    .filter(({ recipe }) => recipe.targetSignature === targetSignature)
    .sort((left, right) => {
      const rank = evidenceRank(left) - evidenceRank(right);
      if (rank !== 0) return rank;
      const { evaluation: a } = left;
      const { evaluation: b } = right;
      if (!a.profit) return b.profit ? 1 : 0;
      if (!b.profit) return -1;
      return a.profit.currency === b.profit.currency
        ? b.profit.amount - a.profit.amount
        : a.profit.currency.localeCompare(b.profit.currency);
    });

  if (methods.length < 2) return null;

  return (
    <DetailSection title="Методы для этой цели">
      <div
        className="craft-risk__table-wrap"
        role="region"
        aria-label="Method comparison, scroll for more columns"
        tabIndex={0}
      >
        <TableSurface>
          <table className="table__content" aria-label="Методы для этой цели">
            <caption>
              Разница с asking price рассчитана по средним затратам. Для одного
              предмета не менее половины крафтов укладываются в P50 затрат, не
              менее девяти из десяти — в P90. Это не вероятность продажи.
            </caption>
            <thead className="table__header">
              <tr className="table__row">
                <th className="table__column" scope="col">
                  Method
                </th>
                <th className="table__column" scope="col">
                  Средние затраты
                </th>
                <th className="table__column" scope="col">
                  Цена объявления
                </th>
                <th className="table__column" scope="col">
                  Оценка разницы с ask
                </th>
                <th className="table__column" scope="col">
                  ROI
                </th>
                <th className="table__column" scope="col">
                  Бюджет P50
                </th>
                <th className="table__column" scope="col">
                  Бюджет P90
                </th>
                <th className="table__column" scope="col">
                  Качество данных / причина недоступности
                </th>
                <th className="table__column" scope="col">
                  Материалы
                </th>
              </tr>
            </thead>
            <tbody className="table__body">
              {methods.map(({ recipe, evaluation, readiness }, index) => (
                <tr className="table__row" key={recipe.id}>
                  <th className="table__column" scope="row">
                    <Link to={`/recipes/${encodeURIComponent(recipe.id)}`}>
                      {recipe.craftMethod}
                    </Link>
                    {readiness && isSingleSellerHypothesis(readiness) ? (
                      <small>Гипотеза цены одного продавца</small>
                    ) : index === 0 &&
                      evaluation.profit &&
                      readiness === undefined ? (
                      <small>Лучший по оценке разницы с ask</small>
                    ) : null}
                  </th>
                  <td className="table__cell">
                    <Money price={evaluation.expectedCraftCost} />
                  </td>
                  <td className="table__cell">
                    <Money price={evaluation.estimatedSalePrice} />
                  </td>
                  <td className="table__cell">
                    {evaluation.profit ? (
                      <ProfitBadge {...evaluation.profit} />
                    ) : (
                      <span aria-label="Profit unavailable">—</span>
                    )}
                  </td>
                  <td
                    className={`table__cell ${economicClass(evaluation.marginPercent)}`}
                  >
                    {evaluation.marginPercent === null ? (
                      <span aria-label="ROI unavailable">—</span>
                    ) : (
                      formatMarginPercent(evaluation.marginPercent)
                    )}
                  </td>
                  <td className="table__cell">
                    <Money price={evaluation.budget?.p50 ?? null} />
                  </td>
                  <td className="table__cell">
                    <Money price={evaluation.budget?.p90 ?? null} />
                  </td>
                  <td className="table__cell">
                    {evaluation.grade ? (
                      <span aria-label={`Evidence grade ${evaluation.grade}`}>
                        {evaluation.grade}
                      </span>
                    ) : evaluation.profit ? (
                      '—'
                    ) : (
                      unpricedMethodReason(evaluation)
                    )}
                  </td>
                  <td className="table__cell">
                    <Link
                      to={`/recipes/${encodeURIComponent(recipe.id)}?view=materials`}
                    >
                      План материалов
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableSurface>
      </div>
    </DetailSection>
  );
}

function unpricedMethodReason(evaluation: CatalogEntry['evaluation']) {
  if (evaluation.profitBlockedReason) return evaluation.profitBlockedReason;
  if (evaluation.errorCode)
    return domainErrorDefinitions[evaluation.errorCode].publicMessage;
  if (evaluation.status === 'stale')
    return domainErrorDefinitions.SNAPSHOT_EXPIRED.publicMessage;
  if (evaluation.status === 'loading')
    return domainErrorDefinitions.SNAPSHOT_MISSING.publicMessage;
  return 'Оценка разницы с asking price недоступна.';
}

export function RecipeMarketStats({
  readiness,
}: {
  readiness:
    | Pick<
        MarketReadinessView,
        | 'fresh'
        | 'capturedAt'
        | 'currentAverageAsk'
        | 'currentTotalListings'
        | 'currentListings'
        | 'coverage'
      >
    | null
    | undefined;
}) {
  const current = readiness?.fresh && readiness.capturedAt ? readiness : null;
  return (
    <>
      <span>
        Средняя цена объявлений
        <strong>
          <Money price={current?.currentAverageAsk ?? null} />
        </strong>
        <small>
          {current?.coverage === 'partial'
            ? 'Собранная выборка · частичное покрытие'
            : 'Среднее по собранным объявлениям, не продажам'}
        </small>
      </span>
      <span>
        Выставлено на продажу
        <strong>
          {current
            ? (
                current.currentTotalListings ?? current.currentListings
              ).toLocaleString('ru-RU')
            : '—'}
        </strong>
        <small>
          {!current
            ? 'Нет свежего снимка'
            : current.currentTotalListings == null
              ? 'Только собранные объявления'
              : current.coverage === 'partial'
                ? `Собрано ${current.currentListings.toLocaleString('ru-RU')} · частичное покрытие`
                : 'Результаты запроса Trade'}
        </small>
      </span>
    </>
  );
}
