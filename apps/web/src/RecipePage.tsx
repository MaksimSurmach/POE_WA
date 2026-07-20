import type { RecipeResponse } from '@poe-worksmith/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  ListingAge,
  Money,
  ProfitBadge,
  StatusPanel,
  Tag,
} from './components.js';
import { createApiClient } from './apiClient.js';
import { RecipeStatePanel } from './failureStates.js';

const apiClient = createApiClient();

const listedAt = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
});

export function RecipePage() {
  const { recipeId } = useParams();
  const [response, setResponse] = useState<RecipeResponse | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let active = true;
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

  if (loadError) {
    return (
      <>
        <Link className="back-link" to="/">
          Back to catalog
        </Link>
        <StatusPanel tone="danger" title="Recipe not found" />
      </>
    );
  }

  if (!response) {
    return (
      <>
        <Link className="back-link" to="/">
          Back to catalog
        </Link>
        <StatusPanel tone="info" title="Loading recipe" />
      </>
    );
  }

  if (!response.data) {
    return (
      <>
        <Link className="back-link" to="/">
          Back to catalog
        </Link>
        <StatusPanel tone="danger" title="Recipe unavailable" />
      </>
    );
  }

  const detail = response.data;

  const { evaluation, recipe } = detail;

  return (
    <article className="recipe-detail">
      <Link className="back-link" to="/">
        ‹ Back to catalog
      </Link>

      <header className="recipe-detail__header">
        <div>
          <h1>{recipe.title}</h1>
          <p>{recipe.summary}</p>
          <div className="recipe-detail__metadata">
            <span className="tag-list" aria-label="Recipe tags">
              {recipe.tags.map((tag) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
            </span>
            <span>{detail.gameVersion}</span>
          </div>
        </div>
      </header>

      <section className="detail-metrics" aria-label="Recipe economics summary">
        <DetailMetric label="Expected cost">
          <Money price={evaluation.expectedCraftCost} />
        </DetailMetric>
        <DetailMetric label="Sale estimate">
          <Money price={evaluation.estimatedSalePrice} />
        </DetailMetric>
        <DetailMetric label="Profit">
          {evaluation.profit ? (
            <ProfitBadge
              amount={evaluation.profit.amount}
              currency={evaluation.profit.currency}
            />
          ) : (
            '—'
          )}
        </DetailMetric>
        <DetailMetric label="Margin">
          {evaluation.marginPercent === null
            ? '—'
            : `${evaluation.marginPercent}%`}
        </DetailMetric>
        <DetailMetric label="Confidence">
          {detail.confidence ? capitalize(detail.confidence) : 'Unavailable'}
        </DetailMetric>
      </section>

      <RecipeStatePanel evaluation={evaluation} />

      <div className="detail-columns">
        <div>
          <DetailSection title="Cost breakdown">
            {detail.costBreakdown ? (
              <p className="cost-formula">
                Base <Money price={detail.costBreakdown.baseCost} /> +{' '}
                {detail.costBreakdown.expectedAttempts} attempts ×{' '}
                <Money price={detail.costBreakdown.materialsPerAttempt} />{' '}
                materials + <Money price={detail.costBreakdown.finishingCost} />{' '}
                finishing ={' '}
                <strong>
                  <Money price={detail.costBreakdown.expectedCost} />
                </strong>
              </p>
            ) : (
              <p>Cost calculation is unavailable.</p>
            )}
          </DetailSection>

          <DetailSection title="Required base">
            <h3>{detail.base.name}</h3>
            <ul>
              {detail.base.requirements.map((requirement) => (
                <li key={requirement}>{requirement}</li>
              ))}
            </ul>
          </DetailSection>

          <DetailSection title="Materials">
            <table className="detail-table materials-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Quantity / attempt</th>
                  <th>Unit price</th>
                  <th>Cost / attempt</th>
                </tr>
              </thead>
              <tbody>
                {detail.materials.map((material) => (
                  <tr key={material.name}>
                    <td data-label="Item">{material.name}</td>
                    <td data-label="Quantity / attempt">
                      {material.quantityPerAttempt}
                    </td>
                    <td data-label="Unit price">
                      <Money price={material.unitPrice} />
                    </td>
                    <td data-label="Cost / attempt">
                      <Money price={material.costPerAttempt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DetailSection>
        </div>

        <div>
          <DetailSection title="Craft steps">
            <ol className="craft-steps">
              {detail.craftSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </DetailSection>

          <DetailSection title="Required result mods">
            <ul>
              {detail.requiredMods.map((mod) => (
                <li key={mod}>{mod}</li>
              ))}
            </ul>
          </DetailSection>
        </div>
      </div>

      <DetailSection title="Price estimators">
        {detail.estimators.length === 0 ? (
          <p>No estimator result is available.</p>
        ) : (
          <div className="estimator-grid">
            {detail.estimators.map((estimator) => (
              <div
                className={
                  estimator.id === detail.selectedEstimatorId
                    ? 'estimator estimator--selected'
                    : 'estimator'
                }
                key={estimator.id}
              >
                <span>{estimator.label}</span>
                <strong>
                  <Money price={estimator.price} />
                </strong>
                {estimator.id === detail.selectedEstimatorId ? (
                  <small>Recipe estimator</small>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </DetailSection>

      <DetailSection title="Top 10 Merchant listings">
        {detail.snapshot?.listings.length ? (
          <table className="detail-table listings-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Price</th>
                <th>Listed time</th>
                <th>Age</th>
                <th>Seller</th>
              </tr>
            </thead>
            <tbody>
              {detail.snapshot.listings.slice(0, 10).map((listing, index) => (
                <tr
                  className={listing.ageSeconds >= 86400 ? 'listing--old' : ''}
                  key={listing.id}
                >
                  <td data-label="Rank">{index + 1}</td>
                  <td data-label="Price">
                    <Money price={listing.price} />
                  </td>
                  <td data-label="Listed time">
                    <time dateTime={listing.indexedAt}>
                      {listedAt.format(new Date(listing.indexedAt))}
                    </time>
                  </td>
                  <td data-label="Age">
                    <ListingAge seconds={listing.ageSeconds} />
                  </td>
                  <td data-label="Seller">{listing.seller}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No Merchant listings are available for this recipe.</p>
        )}
      </DetailSection>
    </article>
  );
}

function DetailMetric({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
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

function capitalize(value: string) {
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}
