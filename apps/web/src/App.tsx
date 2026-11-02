import type { CatalogEntry, CatalogResponse } from '@poe-worksmith/contracts';
import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, Route, Routes } from 'react-router-dom';

import {
  defaultCatalogFilters,
  filterCatalog,
  getPriceStatus,
  type CatalogFilters,
} from './catalog.js';
import { Money, ProfitBadge, StatusPanel } from './components.js';
import { createApiClient } from './apiClient.js';
import { RecipePage } from './RecipePage.js';
import { ItemTooltip } from './ItemTooltip.js';

const itemTypes = [
  'helmet',
  'body-armour',
  'gloves',
  'boots',
  'weapon',
  'shield',
  'belt',
  'ring',
  'amulet',
  'cluster-jewel',
];

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
    () =>
      [
        ...new Set([
          ...itemTypes,
          ...entries.map(({ recipe }) => recipe.category),
        ]),
      ].sort(),
    [entries],
  );
  const filteredEntries = useMemo(
    () => filterCatalog(entries, filters),
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
          <h1 id="catalog-heading">Crafting Recipes</h1>
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
          <section
            className="handbook-controls"
            aria-label="Recipe search and item types"
          >
            <label className="catalog-search">
              <span className="visually-hidden">Search recipes</span>
              <input
                type="search"
                placeholder="Search items or recipes…"
                value={filters.search}
                onChange={(event) => updateFilter('search', event.target.value)}
              />
            </label>
            <div
              className="category-filters"
              role="group"
              aria-label="Filter by item type"
            >
              <button
                aria-pressed={filters.category === 'all'}
                onClick={() => updateFilter('category', 'all')}
                type="button"
              >
                All
              </button>
              {categories.map((category) => (
                <button
                  aria-pressed={filters.category === category}
                  key={category}
                  onClick={() => updateFilter('category', category)}
                  type="button"
                >
                  {category.replaceAll('-', ' ')}
                </button>
              ))}
            </div>
          </section>

          {filteredEntries.length === 0 ? (
            <p className="handbook-empty">No recipes match these filters.</p>
          ) : (
            <section
              className="recipe-table-wrap"
              aria-label="Crafting recipes"
            >
              <table className="recipe-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Type</th>
                    <th>Base</th>
                    <th>Method</th>
                    <th>Expected cost</th>
                    <th>Cheapest ask</th>
                    <th>Potential spread</th>
                    <th>ROI</th>
                    <th>Confidence</th>
                    <th>Price status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEntries.map((entry) => (
                    <CatalogRow entry={entry} key={entry.recipe.id} />
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </>
  );
}

function CatalogRow({ entry }: { entry: CatalogEntry }) {
  const { evaluation, recipe } = entry;
  return (
    <tr>
      <td>
        <div className="recipe-table__identity">
          {entry.itemPreview ? <ItemTooltip item={entry.itemPreview} /> : null}
          <Link to={`/recipes/${recipe.id}`}>
            <strong>{recipe.title}</strong>
          </Link>
        </div>
      </td>
      <td className="recipe-table__type">
        {recipe.category.replaceAll('-', ' ')}
      </td>
      <td>{entry.itemPreview?.name ?? recipe.category.replaceAll('-', ' ')}</td>
      <td>{recipe.craftMethod}</td>
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
          'Not estimated'
        )}
      </td>
      <td>
        {evaluation.marginPercent === null
          ? 'Not estimated'
          : `${evaluation.marginPercent}%`}
      </td>
      <td>{evaluation.confidence ?? 'Unavailable'}</td>
      <td>
        {getPriceStatus(
          evaluation.status,
          evaluation.lastSuccessfulAt,
          Date.now(),
        )}
      </td>
    </tr>
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
