import type { RecipeResponse } from '@poe-worksmith/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Money, StatusPanel } from './components.js';
import { createApiClient } from './apiClient.js';
import { ItemTooltip } from './ItemTooltip.js';

const apiClient = createApiClient();

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

  if (loadError) return <RecipeMessage title="Recipe unavailable" />;
  if (!response?.data)
    return (
      <RecipeMessage
        title={response ? 'Recipe unavailable' : 'Loading recipe'}
      />
    );

  const detail = response.data;
  const { evaluation, recipe } = detail;
  const selectedVariant = detail.variants[0] ?? null;
  const targetMods = detail.presentation.target.modifiers;

  return (
    <article className="recipe-detail recipe-detail--compact">
      <Link className="back-link" to="/">
        ‹ Recipes
      </Link>
      <header className="recipe-detail__header">
        <div className="recipe-detail__identity">
          <ItemTooltip item={detail.presentation.target} />
          <div>
            <h1>{recipe.title}</h1>
            <span className="recipe-detail__type">
              {recipe.category.replaceAll('-', ' ')}
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
          <ol className="craft-steps">
            {selectedVariant.steps.map((step) => {
              const execution = selectedVariant.expectedExecutions.find(
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
                  <small>
                    {step.success
                      ? `${(step.success.probability * 100).toPrecision(3)}% chance`
                      : ''}
                    {execution
                      ? `${step.success ? ' · ' : ''}about ${execution.count.toLocaleString()} uses per item`
                      : ''}
                  </small>
                </li>
              );
            })}
          </ol>
          {selectedVariant.evidence ? (
            <a
              className="craft-evidence"
              href={selectedVariant.evidence.url}
              rel="noreferrer"
              target="_blank"
            >
              Craft of Exile
            </a>
          ) : null}
        </DetailSection>
      ) : null}

      <DetailSection title="Base and target">
        <p className="base-requirements">
          {detail.base.name} · {detail.base.requirements.join(' · ')}
        </p>
        <p className="base-requirements">
          Required: {targetMods.map((modifier) => modifier.label).join(' · ')}
        </p>
      </DetailSection>
    </article>
  );
}

function RecipeMessage({ title }: { title: string }) {
  return (
    <>
      <Link className="back-link" to="/">
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
