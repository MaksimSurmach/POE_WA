import type { RecipeResponse, TrendRange } from '@poe-worksmith/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  Money,
  ProfitBadge,
  StatusPanel,
  economicClass,
} from './components.js';
import { formatMarginPercent } from './catalog.js';
import { createApiClient } from './apiClient.js';
import { ItemTooltip } from './ItemTooltip.js';
import { RecipeTrendPanel } from './MarketTrendsPage.js';
import { CraftRiskSection } from './CraftRiskSection.js';

const apiClient = createApiClient();

export function RecipePage() {
  const { recipeId } = useParams();
  const [response, setResponse] = useState<RecipeResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [trendRange, setTrendRange] = useState<TrendRange>('30d');

  useEffect(() => {
    let active = true;
    setResponse(null);
    setLoadError(false);
    if (!recipeId) {
      setLoadError(true);
      return () => {
        active = false;
      };
    }
    apiClient
      .getRecipe(recipeId)
      .then((recipe) => {
        if (active) setResponse(recipe);
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [recipeId]);

  if (loadError) return <RecipeMessage title="Recipe unavailable" />;
  if (!response?.data)
    return (
      <RecipeMessage
        title={response ? 'Recipe unavailable' : 'Loading recipe'}
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

      {detail.uncertainties.length ? (
        <p className="recipe-warning">{detail.uncertainties.join(' ')}</p>
      ) : null}
      <div className="recipe-economics" aria-label="Current economics">
        <span>
          Indicative expected cost{' '}
          <strong>
            <Money price={evaluation.expectedCraftCost} />
          </strong>
        </span>
        <span>
          Cheapest confirmed ask{' '}
          <strong>
            <Money price={evaluation.estimatedSalePrice} />
          </strong>
        </span>
        <span>
          Potential profit{' '}
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
      <p className="catalog-price-note">
        ROI = (asking price − expected cost) ÷ expected cost × 100%. A cost of
        10 div and an ask of 12 div means 2 div profit and 20% ROI. Expected
        cost is a mean across repeated crafts, not a guaranteed budget.
      </p>

      <CraftRiskSection key={recipe.id} recipeId={recipe.id} />

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
          Prices are asking prices, not confirmed sales. ROI requires a complete
          output search and asks from at least two independent sellers.
          Incomplete output coverage or a single seller cannot establish profit
          or ROI.
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
