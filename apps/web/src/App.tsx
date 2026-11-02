import type { CatalogEntry, CatalogResponse } from '@poe-worksmith/contracts';
import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, Route, Routes } from 'react-router-dom';

import {
  defaultCatalogFilters,
  filterCatalog,
  type CatalogFilters,
} from './catalog.js';
import { Money, StatusPanel, Tag } from './components.js';
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
  const [loadError, setLoadError] = useState(false);
  const entries =
    response?.data?.entries.filter(
      ({ recipe }) => recipe.category === 'cluster-jewel',
    ) ?? [];
  const tags = useMemo(
    () =>
      [...new Set(entries.flatMap(({ recipe }) => recipe.tags))]
        .filter((tag) => tag !== 'cluster-jewel')
        .sort(),
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
          <h1 id="catalog-heading">Cluster Jewels</h1>
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
            aria-label="Cluster jewel search and tags"
          >
            <label className="catalog-search">
              <span className="visually-hidden">Search cluster jewels</span>
              <input
                type="search"
                placeholder="Search cluster jewels…"
                value={filters.search}
                onChange={(event) => updateFilter('search', event.target.value)}
              />
            </label>
            <div
              className="catalog-tags"
              role="group"
              aria-label="Filter by tag"
            >
              <button
                aria-pressed={filters.tag === 'all'}
                onClick={() => updateFilter('tag', 'all')}
                type="button"
              >
                All
              </button>
              {tags.map((tag) => (
                <button
                  aria-pressed={filters.tag === tag}
                  key={tag}
                  onClick={() => updateFilter('tag', tag)}
                  type="button"
                >
                  {tag}
                </button>
              ))}
            </div>
          </section>

          {filteredEntries.length === 0 ? (
            <p className="handbook-empty">No recipes match these filters.</p>
          ) : (
            <section
              className="cluster-table-wrap"
              aria-label="Cluster jewel recipes"
            >
              <table className="cluster-table">
                <thead>
                  <tr>
                    <th>Cluster jewel</th>
                    <th>Tags</th>
                    <th>Base</th>
                    <th>Method</th>
                    <th>Expected cost</th>
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
        <div className="cluster-table__identity">
          {entry.itemPreview ? <ItemTooltip item={entry.itemPreview} /> : null}
          <Link to={`/recipes/${recipe.id}`}>
            <strong>{recipe.title}</strong>
          </Link>
        </div>
      </td>
      <td>
        <span className="cluster-table__tags">
          {recipe.tags
            .filter((tag) => tag !== 'cluster-jewel')
            .map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
        </span>
      </td>
      <td>{entry.itemPreview?.name ?? 'Cluster Jewel'}</td>
      <td>{recipe.craftMethod}</td>
      <td>
        <Money price={evaluation.expectedCraftCost} />
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
