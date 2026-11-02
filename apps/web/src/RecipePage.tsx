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
import { ItemTooltip } from './ItemTooltip.js';

const apiClient = createApiClient();

export function RecipePage() {
  const { recipeId } = useParams();
  const [response, setResponse] = useState<RecipeResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(
    null,
  );

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

  if (loadError) return <RecipeMessage title="Recipe not found" />;
  if (!response) return <RecipeMessage title="Loading recipe" />;
  if (!response.data) return <RecipeMessage title="Recipe unavailable" />;

  const detail = response.data;
  const { evaluation, recipe } = detail;
  const target = detail.presentation.target;
  const modifiers = ['implicit', 'prefix', 'suffix'] as const;
  const selectedVariant =
    detail.variants.find(({ id }) => id === selectedVariantId) ??
    detail.variants[0] ??
    null;

  return (
    <article className="recipe-detail">
      <Link className="back-link" to="/">
        ‹ All recipes
      </Link>
      <header className="recipe-detail__header">
        <div className="recipe-detail__identity">
          <ItemTooltip item={target} />
          <div>
            <h1>{recipe.title}</h1>
            <p>{recipe.summary}</p>
          </div>
        </div>
        <div className="recipe-detail__metadata">
          <span className="tag-list" aria-label="Recipe tags">
            {recipe.tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </span>
          <span>{detail.gameVersion}</span>
        </div>
      </header>

      <section className="detail-metrics" aria-label="Recipe economics">
        <DetailMetric label="Expected cost">
          <Money price={evaluation.expectedCraftCost} />
        </DetailMetric>
        <DetailMetric label="Cheapest ask">
          <Money price={evaluation.estimatedSalePrice} />
        </DetailMetric>
        <DetailMetric label="Potential profit">
          {evaluation.profit ? (
            <ProfitBadge {...evaluation.profit} />
          ) : (
            'Not estimated'
          )}
        </DetailMetric>
        <DetailMetric label="ROI">
          {evaluation.marginPercent === null
            ? 'Not estimated'
            : `${evaluation.marginPercent}%`}
        </DetailMetric>
        <DetailMetric label="Confidence">
          {detail.confidence ? capitalize(detail.confidence) : 'Unavailable'}
        </DetailMetric>
      </section>

      {detail.variants.length ? (
        <DetailSection title="Crafting methods">
          <div
            className="variant-tabs"
            role="group"
            aria-label="Crafting methods"
          >
            {detail.variants.map((variant) => (
              <button
                aria-pressed={selectedVariant?.id === variant.id}
                className={
                  selectedVariant?.id === variant.id ? 'is-selected' : ''
                }
                key={variant.id}
                onClick={() => setSelectedVariantId(variant.id)}
                type="button"
              >
                {variant.name}
                <span>
                  {variant.expectedCost ? (
                    <Money price={variant.expectedCost} />
                  ) : (
                    'Not estimated'
                  )}
                </span>
              </button>
            ))}
          </div>
          {selectedVariant ? (
            <div className="variant-detail">
              <div className="variant-cost-summary">
                <span>Expected cost</span>
                <strong>
                  <Money price={selectedVariant.expectedCost} />
                </strong>
                <span>Cost per attempt</span>
                <strong>
                  <Money price={selectedVariant.materialsPerAttempt} />
                </strong>
              </div>
              <ol className="craft-steps">
                {selectedVariant.steps.map((step) => (
                  <li key={step.id}>
                    <strong>{step.title}</strong>
                    <p>{step.action}</p>
                    {step.success ? (
                      <p>
                        Success chance:{' '}
                        {(step.success.probability * 100).toPrecision(3)}% ·{' '}
                        {step.success.evidence.method}
                      </p>
                    ) : (
                      <p>Success chance: unknown (no sourced odds).</p>
                    )}
                    <p>
                      Continue when: {step.continueWhen}. On failure:{' '}
                      {step.failureAction}.
                    </p>
                    {step.materials.length ? (
                      <ul>
                        {step.materials.map((material) => (
                          <li key={material.itemId}>
                            {material.quantityPerAttempt ?? 'Qty unknown'} ×{' '}
                            {material.name}:{' '}
                            <Money price={material.costPerAttempt} /> per
                            attempt
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ol>
              {selectedVariant.expectedCost ? (
                <p>
                  Expected total includes the base and uses sourced per-step
                  execution counts; staged chances are not multiplied as
                  independent rerolls.
                </p>
              ) : (
                <p>
                  Expected total is not estimated because execution counts,
                  material quantities, or current prices are unknown.
                </p>
              )}
              {selectedVariant.evidence ? (
                <a
                  href={selectedVariant.evidence.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  {selectedVariant.evidence.method} · patch{' '}
                  {selectedVariant.evidence.patch} · verified{' '}
                  {selectedVariant.evidence.verifiedAt}
                </a>
              ) : null}
            </div>
          ) : null}
        </DetailSection>
      ) : null}

      <div className="detail-columns">
        <div>
          <DetailSection title="Target modifiers">
            <p className="target-note">
              Target requirements; these are not observed market rolls.
            </p>
            {modifiers.map((kind) => {
              const list = target.modifiers.filter(
                (modifier) => modifier.generationType === kind,
              );
              return list.length ? (
                <div className="target-modifiers" key={kind}>
                  <strong>
                    {kind === 'implicit'
                      ? 'Implicits'
                      : `${capitalize(kind)}es`}
                  </strong>
                  <ul>
                    {list.map((modifier) => (
                      <li key={modifier.canonicalId}>{modifier.label}</li>
                    ))}
                  </ul>
                </div>
              ) : null;
            })}
            {detail.requiredMods.length ? (
              <div className="target-modifiers">
                <strong>Other target conditions</strong>
                <ul>
                  {detail.requiredMods.map((modifier) => (
                    <li key={modifier}>{modifier}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </DetailSection>
          <DetailSection title="Required base">
            <h3>{detail.base.name}</h3>
            <ul>
              {detail.base.requirements.map((requirement) => (
                <li key={requirement}>{requirement}</li>
              ))}
            </ul>
          </DetailSection>
          {!detail.variants.length ? (
            <DetailSection title="Materials">
              <table className="detail-table materials-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Qty / attempt</th>
                    <th>Unit price</th>
                    <th>Cost / attempt</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.materials.map((material) => (
                    <tr key={material.name}>
                      <td data-label="Item">{material.name}</td>
                      <td data-label="Qty / attempt">
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
          ) : null}
        </div>
        <div>
          <DetailSection title="Crafting steps">
            <ol className="craft-steps">
              {detail.craftSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </DetailSection>
          <DetailSection title="Expected cost">
            {detail.costBreakdown ? (
              <p className="cost-formula">
                {detail.costBreakdown.expectedAttempts} expected attempts ×{' '}
                <Money price={detail.costBreakdown.materialsPerAttempt} /> per
                attempt + <Money price={detail.costBreakdown.baseCost} /> base +{' '}
                <Money price={detail.costBreakdown.finishingCost} /> finishing ={' '}
                <strong>
                  <Money price={detail.costBreakdown.expectedCost} />
                </strong>
              </p>
            ) : (
              <p>Expected total is not estimated.</p>
            )}
          </DetailSection>
          <DetailSection title="Market comparison">
            {detail.snapshot?.listings.length ? (
              <table className="detail-table listings-table">
                <thead>
                  <tr>
                    <th>Ask</th>
                    <th>Price</th>
                    <th>Age</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.snapshot.listings
                    .slice(0, 5)
                    .map((listing, index) => (
                      <tr key={listing.id}>
                        <td data-label="Ask">
                          {index === 0 ? 'Cheapest' : `#${index + 1}`}
                        </td>
                        <td data-label="Price">
                          <Money price={listing.price} />
                        </td>
                        <td data-label="Age">
                          <ListingAge seconds={listing.ageSeconds} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : (
              <p>Comparable asking prices are unavailable.</p>
            )}
          </DetailSection>
        </div>
      </div>
    </article>
  );
}

function RecipeMessage({ title }: { title: string }) {
  return (
    <>
      <Link className="back-link" to="/">
        ‹ All recipes
      </Link>
      <StatusPanel
        tone={title === 'Loading recipe' ? 'info' : 'danger'}
        title={title}
      />
    </>
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
