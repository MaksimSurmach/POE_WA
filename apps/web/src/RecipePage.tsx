import type { RecipeResponse } from '@poe-worksmith/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Money, StatusPanel, Tag } from './components.js';
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

  if (loadError) return <RecipeMessage title="Recipe unavailable" />;
  if (!response?.data)
    return (
      <RecipeMessage
        title={response ? 'Recipe unavailable' : 'Loading recipe'}
      />
    );

  const detail = response.data;
  const { evaluation, recipe } = detail;
  const selectedVariant =
    detail.variants.find(({ id }) => id === selectedVariantId) ??
    detail.variants[0] ??
    null;
  const targetMods = detail.presentation.target.modifiers;

  return (
    <article className="recipe-detail recipe-detail--compact">
      <Link className="back-link" to="/">
        ‹ Cluster Jewels
      </Link>
      <header className="recipe-detail__header">
        <div className="recipe-detail__identity">
          <ItemTooltip item={detail.presentation.target} />
          <div>
            <h1>{recipe.title}</h1>
            <span className="tag-list" aria-label="Recipe tags">
              {recipe.tags
                .filter((tag) => tag !== 'cluster-jewel')
                .map((tag) => (
                  <Tag key={tag}>{tag}</Tag>
                ))}
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
          Expected craft cost{' '}
          <strong>
            <Money price={evaluation.expectedCraftCost} />
          </strong>
        </span>
        <span>
          Cheapest ask{' '}
          <strong>
            <Money price={evaluation.estimatedSalePrice} />
          </strong>
        </span>
        <span>
          Potential profit{' '}
          <strong>
            {evaluation.profit ? (
              <Money price={evaluation.profit} />
            ) : (
              'Not estimated'
            )}
          </strong>
        </span>
      </div>

      {selectedVariant ? (
        <DetailSection title="Craft">
          <div
            className="variant-tabs"
            role="group"
            aria-label="Crafting method"
          >
            {detail.variants.map((variant) => (
              <button
                aria-pressed={selectedVariant.id === variant.id}
                className={
                  selectedVariant.id === variant.id ? 'is-selected' : ''
                }
                key={variant.id}
                onClick={() => setSelectedVariantId(variant.id)}
                type="button"
              >
                {variant.name}{' '}
                <span>
                  <Money price={variant.expectedCost} />
                </span>
              </button>
            ))}
          </div>
          <ol className="craft-steps">
            {selectedVariant.steps.map((step) => (
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
                <small>
                  {step.success
                    ? `Success chance: ${(step.success.probability * 100).toPrecision(3)}%`
                    : 'Success chance not estimated'}{' '}
                  · Continue when: {step.continueWhen}
                </small>
              </li>
            ))}
          </ol>
          <p className="craft-note">
            Total cost and odds unavailable until verified. On failure:{' '}
            {selectedVariant.steps
              .map(({ failureAction }) => failureAction)
              .join(' ')}
          </p>
          {selectedVariant.evidence ? (
            <a
              className="craft-evidence"
              href={selectedVariant.evidence.url}
              rel="noreferrer"
              target="_blank"
            >
              Crafting source · {selectedVariant.evidence.patch}
            </a>
          ) : null}
        </DetailSection>
      ) : null}

      <DetailSection title="Base and target">
        <p className="base-requirements">
          {detail.base.name}: {detail.base.requirements.join(' · ')}
        </p>
        <ul className="target-modifier-list">
          {targetMods.map((modifier) => (
            <li key={modifier.canonicalId}>{modifier.label}</li>
          ))}
        </ul>
        <small>Target requirements; these are not observed market rolls.</small>
      </DetailSection>
    </article>
  );
}

function RecipeMessage({ title }: { title: string }) {
  return (
    <>
      <Link className="back-link" to="/">
        ‹ Cluster Jewels
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
