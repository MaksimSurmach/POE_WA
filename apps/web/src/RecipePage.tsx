import {
  domainErrorDefinitions,
  type CatalogEntry,
  type CatalogResponse,
  type RecipeResponse,
  type TrendRange,
} from '@poe-worksmith/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  Money,
  ProfitBadge,
  StatusPanel,
  economicClass,
} from './components.js';
import { formatMarginPercent } from './catalog.js';
import { ApiClientError, createApiClient } from './apiClient.js';
import { ItemTooltip } from './ItemTooltip.js';
import { RecipeTrendPanel } from './MarketTrendsPage.js';
import { CraftRiskSection } from './CraftRiskSection.js';
import { RecipeIntelligencePanel } from './IntelligencePanel.js';

const apiClient = createApiClient('', (url, options) =>
  fetch(url, { ...options, signal: AbortSignal.timeout(15_000) }),
);

export function RecipePage() {
  const { recipeId } = useParams();
  const [response, setResponse] = useState<RecipeResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [trendRange, setTrendRange] = useState<TrendRange>('30d');
  const [catalogEntries, setCatalogEntries] = useState<CatalogEntry[]>([]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let catalog: CatalogResponse | null = null;
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
          if (active) setCatalogEntries(catalog?.data?.entries ?? []);
        }
      } catch (error) {
        if (active) {
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
  }, [recipeId]);

  if (!response?.data)
    return (
      <RecipeMessage
        title={response || loadError ? 'Recipe unavailable' : 'Loading recipe'}
      />
    );

  const detail = response.data;
  const { evaluation, recipe } = detail;
  const method = detail.method;
  const targetMods = detail.presentation.target.modifiers;
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
      <Link className="back-link" to="/recipes">
        ‹ Recipes
      </Link>
      <Link
        className="back-link"
        to={`/factory?recipe=${encodeURIComponent(recipe.id)}`}
      >
        Start a production batch →
      </Link>
      {loadError ? (
        <p role="status" className="recipe-warning">
          Price update unavailable. Displayed prices are from the last
          successful load.
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
        {detail.baseTradeUrl ? (
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

      <div className="recipe-economics" aria-label="Current economics">
        <span>
          Indicative expected cost{' '}
          <strong>
            <Money price={evaluation.expectedCraftCost} />
          </strong>
        </span>
        <span>
          Comparable asking price{' '}
          <strong>
            <Money price={evaluation.estimatedSalePrice} />
          </strong>
        </span>
        <span>
          Margin at ask{' '}
          <strong>
            {evaluation.profit ? (
              <ProfitBadge {...evaluation.profit} />
            ) : (
              'Not estimated'
            )}
          </strong>
        </span>
        <span>
          ROI{' '}
          <strong className={economicClass(evaluation.marginPercent)}>
            {evaluation.marginPercent === null
              ? 'Not estimated'
              : formatMarginPercent(evaluation.marginPercent)}
          </strong>
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
      <p className="catalog-price-note">
        ROI = (asking price − expected cost) ÷ expected cost × 100%. A cost of
        10 div and an ask of 12 div gives a 2 div spread and 20% ROI at that
        ask. Expected cost is a mean across repeated crafts, not a guaranteed
        budget.
      </p>

      <MethodsForTarget
        entries={catalogEntries}
        targetSignature={detail.targetSignature}
      />

      {method ? (
        <DetailSection title={method.name}>
          {evaluation.status === 'stale' ? (
            <p className="recipe-warning">
              Material prices below are past observations. Refresh prices before
              using them as a current crafting budget.
            </p>
          ) : null}
          <p>
            Starting base: <Money price={method.baseCost} /> ×{' '}
            {method.expectedBases ?? '?'} expected bases. Add every material
            cost below.
          </p>
          <ol className="craft-steps">
            {method.steps.map((step) => {
              const execution = method.expectedExecutions.find(
                ({ stepId }) => stepId === step.id,
              );
              return (
                <li key={step.id}>
                  <strong>{step.action}</strong>
                  <span>
                    {step.materials
                      .map(
                        (material) =>
                          `${material.quantityPerAttempt ?? '?'} × ${material.name}`,
                      )
                      .join(' · ')}
                  </span>
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
                                · {execution.count.toLocaleString()} executions
                                ={' '}
                                <Money
                                  price={{
                                    currency: material.costPerAttempt.currency,
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

      <DetailSection title="Price evidence">
        <p>
          Starting base: <Money price={method.baseCost} /> · Expected bases per
          finished item: {method.expectedBases ?? 'Not estimated'}
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
              {new Date(source.capturedAt).toLocaleString('en-US')}
            </time>
            {source.verifiedAt && source.verifiedAt !== source.capturedAt ? (
              <>
                {' '}
                · Rechecked{' '}
                <time dateTime={source.verifiedAt}>
                  {new Date(source.verifiedAt).toLocaleString('en-US')}
                </time>
              </>
            ) : null}
          </p>
        ))}
        <p>
          {detail.snapshot
            ? `${detail.snapshot.listings.length} verified sellers · ${detail.snapshot.coverage ?? 'unknown'} search coverage${detail.snapshot.sortedPageComplete ? ' (complete lowest-price page)' : detail.snapshot.sortedSampleComplete ? ` (sorted price sample: 20/${detail.snapshot.totalResults} offers)` : ''}${detail.snapshot.listings.length > 0 && detail.snapshot.listings.length <= 2 ? ' · Thin market' : ''} · ${new Date(detail.snapshot.capturedAt).toLocaleString('en-US')}`
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
      {detail.marketActivity ? (
        <DetailSection title="Market activity">
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
          <p>
            Last 72 h: {detail.marketActivity.repriced72h} repriced ·{' '}
            {detail.marketActivity.inferredExits72h} inferred exits ·{' '}
            {detail.marketActivity.uncertainExits72h} uncertain exits
          </p>
          {detail.marketActivity.recentExitAsk ? (
            <p>
              Median last ask of inferred exits:{' '}
              <Money price={detail.marketActivity.recentExitAsk} />
            </p>
          ) : null}
          <p>
            <Link to="/factory">Your confirmed sales in My Factory</Link>
          </p>
        </DetailSection>
      ) : null}
      <DetailSection title="Price history">
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
      <CraftRiskSection key={recipe.id} recipeId={recipe.id} />
      {detail.marketActivity === undefined ? (
        <RecipeIntelligencePanel
          key={`intelligence:${recipe.id}`}
          recipeId={recipe.id}
        />
      ) : null}
      {detail.uncertainties.length ? (
        <details className="detail-section">
          <summary>Crafting and pricing caveats</summary>
          <ul>
            {detail.uncertainties.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <DetailSection title="Base and target">
        <ItemTooltip item={detail.presentation.base} />
        <p className="base-requirements">
          {detail.base.name} · {detail.base.requirements.join(' · ')}
        </p>
        {(['prefix', 'suffix', 'implicit', 'enchant', 'other'] as const).map(
          (group) => (
            <p className="base-requirements" key={group}>
              {group}:{' '}
              {targetMods
                .filter((m) => m.generationType === group)
                .map((m) => m.label)
                .join(' · ') || 'None required'}
            </p>
          ),
        )}
        <p>
          Margin uses eligible asking prices. One independent matching seller
          can qualify for grade C. A validated sorted sample earns at most grade
          B. My Factory tracks confirmed sales.
        </p>
      </DetailSection>
    </article>
  );
}

function RecipeMessage({ title }: { title: string }) {
  return (
    <>
      <Link className="back-link" to="/recipes">
        ‹ Recipes
      </Link>
      <StatusPanel
        tone={title === 'Loading recipe' ? 'info' : 'danger'}
        title={title}
      />
    </>
  );
}

function DetailSection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="detail-section">
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
    .sort(({ evaluation: a }, { evaluation: b }) => {
      if (!a.profit) return b.profit ? 1 : 0;
      if (!b.profit) return -1;
      return b.profit.amount - a.profit.amount;
    });

  if (methods.length < 2) return null;

  return (
    <DetailSection title="Methods for this target">
      <div
        className="craft-risk__table-wrap"
        role="region"
        aria-label="Method comparison, scroll for more columns"
        tabIndex={0}
      >
        <table aria-label="Methods for this target">
          <caption>
            Expected profit uses mean cost. For one finished item, at least half
            of runs cost at or below p50, and at least nine in ten cost at or
            below p90.
          </caption>
          <thead>
            <tr>
              <th scope="col">Method</th>
              <th scope="col">Mean cost</th>
              <th scope="col">Sale ask</th>
              <th scope="col">Expected profit</th>
              <th scope="col">ROI</th>
              <th scope="col">Budget p50</th>
              <th scope="col">Budget p90</th>
              <th scope="col">Grade or block reason</th>
            </tr>
          </thead>
          <tbody>
            {methods.map(({ recipe, evaluation }, index) => (
              <tr key={recipe.id}>
                <th scope="row">
                  <Link to={`/recipes/${encodeURIComponent(recipe.id)}`}>
                    {recipe.craftMethod}
                  </Link>
                  {index === 0 && evaluation.profit ? (
                    <small>Best by expected profit</small>
                  ) : null}
                </th>
                <td>
                  <Money price={evaluation.expectedCraftCost} />
                </td>
                <td>
                  <Money price={evaluation.estimatedSalePrice} />
                </td>
                <td>
                  {evaluation.profit ? (
                    <ProfitBadge {...evaluation.profit} />
                  ) : (
                    <span aria-label="Profit unavailable">—</span>
                  )}
                </td>
                <td className={economicClass(evaluation.marginPercent)}>
                  {evaluation.marginPercent === null ? (
                    <span aria-label="ROI unavailable">—</span>
                  ) : (
                    formatMarginPercent(evaluation.marginPercent)
                  )}
                </td>
                <td>
                  <Money price={evaluation.budget?.p50 ?? null} />
                </td>
                <td>
                  <Money price={evaluation.budget?.p90 ?? null} />
                </td>
                <td>
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
              </tr>
            ))}
          </tbody>
        </table>
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
  return 'Expected profit unavailable.';
}
