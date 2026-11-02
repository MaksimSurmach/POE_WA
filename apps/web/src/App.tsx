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
  const [loadError, setLoadError] = useState(false);
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

  function updateFilter<K extends keyof CatalogFilters>(
    key: K,
    value: CatalogFilters[K],
  ) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  return (
    <>
      <section className="catalog-heading" aria-labelledby="catalog-heading">
        <div>
          <h1 id="catalog-heading">Crafting recipes</h1>
          <p>Compare crafting costs with current market prices.</p>
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
  const { evaluation, recipe, snapshot } = entry;
  const spread = evaluation.profit?.amount;
  const ageHours = snapshot
    ? Math.floor((Date.now() - Date.parse(snapshot.capturedAt)) / 3_600_000)
    : null;
  return (
    <Link className="handbook-row" to={`/recipes/${recipe.id}`}>
      <div className="handbook-row__name">
        <strong>{recipe.title}</strong>
        <span>{recipe.category}</span>
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
        {ageHours === null
          ? 'Price unavailable'
          : ageHours > 1
            ? 'Price outdated'
            : 'Price current'}
      </span>
      <span className="handbook-row__open" aria-hidden="true">
        ›
      </span>
    </Link>
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
