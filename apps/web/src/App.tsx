import type { CatalogEntry, CatalogResponse } from '@poe-worksmith/contracts';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Outlet, Route, Routes } from 'react-router-dom';

import {
  defaultCatalogFilters,
  filterAndSortCatalog,
  type CatalogFilters,
} from './catalog.js';
import { Money, ProfitBadge, StatusPanel, Tag } from './components.js';
import { createApiClient } from './apiClient.js';
import { RecipePage } from './RecipePage.js';
import { ItemTooltip } from './ItemTooltip.js';

const apiClient = createApiClient();

function AppShell() {
  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link className="brand" to="/" aria-label="Worksmith Handbook home">
            <span>Worksmith</span> Handbook
          </Link>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </>
  );
}

function CatalogRoute() {
  const [filters, setFilters] = useState<CatalogFilters>(defaultCatalogFilters);
  const [response, setResponse] = useState<CatalogResponse | null>(null);
  const [leagueLabel, setLeagueLabel] = useState('League unavailable');
  const [leagueIsFallback, setLeagueIsFallback] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refreshState, setRefreshState] = useState<
    'idle' | 'working' | 'queued' | 'existing' | 'error'
  >('idle');
  const entries = response?.data?.entries ?? [];
  const categories = useMemo(
    () => [...new Set(entries.map(({ recipe }) => recipe.category))].sort(),
    [entries],
  );
  const tags = useMemo(
    () => [...new Set(entries.flatMap(({ recipe }) => recipe.tags))].sort(),
    [entries],
  );
  const filteredEntries = useMemo(
    () => filterAndSortCatalog(entries, filters),
    [entries, filters],
  );

  useEffect(() => {
    let active = true;
    apiClient
      .getCatalog()
      .then((catalog) => {
        if (active) setResponse(catalog);
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    apiClient
      .getCurrentLeague()
      .then(({ data }) => {
        if (active) {
          setLeagueLabel(data.name);
          setLeagueIsFallback(false);
        }
      })
      .catch(async () => {
        try {
          const { data } = await apiClient.getLeagues();
          const league =
            data.find(({ isCurrent }) => isCurrent) ??
            [...data].sort(
              (left, right) =>
                Date.parse(right.syncedAt) - Date.parse(left.syncedAt),
            )[0];
          if (active && league) {
            setLeagueLabel(
              `Last known: ${league.name} · synced ${new Date(league.syncedAt).toLocaleString()}`,
            );
            setLeagueIsFallback(true);
          }
        } catch {
          if (active) setLeagueLabel('League unavailable');
        }
      });
    return () => {
      active = false;
    };
  }, []);

  function updateFilter<K extends keyof CatalogFilters>(
    key: K,
    value: CatalogFilters[K],
  ) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  async function refreshPrices() {
    setRefreshState('working');
    try {
      const result = await apiClient.triggerPriceRefresh();
      setRefreshState(result.data.accepted ? 'queued' : 'existing');
    } catch {
      setRefreshState('error');
    }
  }

  return (
    <>
      <section className="catalog-heading" aria-labelledby="catalog-heading">
        <div>
          <h1 id="catalog-heading">Crafting recipes</h1>
          <p>Compare crafting costs with current market prices.</p>
          <p
            className={
              leagueIsFallback ? 'league-label is-fallback' : 'league-label'
            }
          >
            Path of Exile 1 · {leagueLabel}
          </p>
        </div>
        <div className="refresh-control">
          <button
            disabled={refreshState === 'working'}
            onClick={refreshPrices}
            type="button"
          >
            {refreshState === 'working' ? 'Refreshing…' : 'Refresh prices'}
          </button>
          <span aria-live="polite">
            {refreshState === 'queued'
              ? 'Price refresh queued.'
              : refreshState === 'existing'
                ? 'A price refresh is already queued or running.'
                : refreshState === 'error'
                  ? 'Price refresh unavailable.'
                  : ''}
          </span>
        </div>
      </section>

      {loadError ? (
        <StatusPanel tone="danger" title="Recipes unavailable">
          The recipe list could not be loaded. Try again when the service is
          available.
        </StatusPanel>
      ) : !response ? (
        <StatusPanel tone="info" title="Loading recipes" />
      ) : entries.length === 0 ? (
        <section className="empty-state" aria-labelledby="empty-heading">
          <h2 id="empty-heading">No recipes available</h2>
          <p>Manually maintained recipes will appear here.</p>
        </section>
      ) : (
        <>
          <section className="handbook-controls" aria-label="Recipe filters">
            <Filter label="Search">
              <input
                type="search"
                placeholder="Name or summary"
                value={filters.search}
                onChange={(event) => updateFilter('search', event.target.value)}
              />
            </Filter>
            <Filter label="Category">
              <select
                value={filters.category}
                onChange={(event) =>
                  updateFilter('category', event.target.value)
                }
              >
                <option value="all">All categories</option>
                {categories.map((category) => (
                  <option key={category}>{category}</option>
                ))}
              </select>
            </Filter>
            <Filter label="Tag">
              <select
                value={filters.tag}
                onChange={(event) => updateFilter('tag', event.target.value)}
              >
                <option value="all">All tags</option>
                {tags.map((tag) => (
                  <option key={tag}>{tag}</option>
                ))}
              </select>
            </Filter>
            <Filter label="Max expected cost (chaos)">
              <input
                min="0"
                placeholder="Any cost"
                type="number"
                value={filters.budget === 'all' ? '' : filters.budget}
                onChange={(event) =>
                  updateFilter('budget', event.target.value || 'all')
                }
              />
            </Filter>
            <Filter label="Profitability">
              <select
                value={filters.profitability}
                onChange={(event) =>
                  updateFilter('profitability', event.target.value)
                }
              >
                <option value="all">Any result</option>
                <option value="positive">Positive spread</option>
                <option value="negative">Zero or negative spread</option>
                <option value="unknown">Not estimated</option>
              </select>
            </Filter>
            <Filter label="Confidence">
              <select
                value={filters.confidence}
                onChange={(event) =>
                  updateFilter('confidence', event.target.value)
                }
              >
                <option value="all">Any confidence</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
                <option value="unknown">Unavailable</option>
              </select>
            </Filter>
            <Filter label="Sort">
              <select
                value={filters.sort}
                onChange={(event) =>
                  updateFilter(
                    'sort',
                    event.target.value as CatalogFilters['sort'],
                  )
                }
              >
                <option value="profit">Profitability</option>
                <option value="cost">Expected cost</option>
                <option value="margin">ROI</option>
                <option value="freshness">Price freshness</option>
                <option value="confidence">Confidence</option>
              </select>
            </Filter>
          </section>

          {filteredEntries.length === 0 ? (
            <p className="handbook-empty">No recipes match these filters.</p>
          ) : (
            <section className="handbook-list" aria-label="Crafting recipes">
              {filteredEntries.map((entry) => (
                <CatalogRow entry={entry} key={entry.recipe.id} />
              ))}
            </section>
          )}
        </>
      )}
    </>
  );
}

function Filter({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="filter-control">
      <span>{label}</span>
      {children}
    </label>
  );
}

function CatalogRow({ entry }: { entry: CatalogEntry }) {
  const { evaluation, recipe } = entry;
  const spread = evaluation.profit?.amount;
  const ageHours = evaluation.lastSuccessfulAt
    ? Math.floor(
        (Date.now() - Date.parse(evaluation.lastSuccessfulAt)) / 3_600_000,
      )
    : null;
  return (
    <div className="handbook-row">
      {entry.itemPreview ? <ItemTooltip item={entry.itemPreview} /> : null}
      <Link className="handbook-row__link" to={`/recipes/${recipe.id}`}>
        <div className="handbook-row__name">
          <strong>{recipe.title}</strong>
          <span>
            {entry.itemPreview
              ? `${entry.itemPreview.name} · ${recipe.category}`
              : recipe.category}
          </span>
        </div>
        <div className="handbook-row__tags" aria-label={`${recipe.title} tags`}>
          {recipe.tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </div>
        <RecipeValue label="Expected cost">
          <Money price={evaluation.expectedCraftCost} />
        </RecipeValue>
        <RecipeValue label="Cheapest ask">
          <Money price={evaluation.estimatedSalePrice} />
        </RecipeValue>
        <RecipeValue label="Spread">
          {spread === null || spread === undefined ? (
            <span className="economic-unknown">Not estimated</span>
          ) : (
            <span
              className={spread > 0 ? 'economic-positive' : 'economic-negative'}
            >
              <ProfitBadge
                amount={spread}
                currency={evaluation.profit!.currency}
              />
            </span>
          )}
        </RecipeValue>
        <span className="handbook-row__freshness">
          {evaluation.status === 'stale' || (ageHours !== null && ageHours > 1)
            ? 'Price outdated'
            : ageHours === null
              ? 'Price unavailable'
              : 'Price current'}
        </span>
        <RecipeValue label="Confidence">
          {evaluation.confidence
            ? `${evaluation.confidence} confidence`
            : 'Unavailable'}
        </RecipeValue>
        <span className="handbook-row__open" aria-hidden="true">
          ›
        </span>
      </Link>
    </div>
  );
}

function RecipeValue({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <span className="handbook-value">
      <span>{label}</span>
      <strong>{children}</strong>
    </span>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<CatalogRoute />} />
        <Route path="catalog" element={<CatalogRoute />} />
        <Route path="recipes/:recipeId" element={<RecipePage />} />
      </Route>
    </Routes>
  );
}
