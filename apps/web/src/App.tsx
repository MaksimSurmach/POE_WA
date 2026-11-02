import type {
  CatalogEntry,
  CatalogResponse,
  MarketTargetInput,
} from '@poe-worksmith/contracts';
import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, Route, Routes } from 'react-router-dom';

import {
  defaultCatalogFilters,
  filterMarketTargets,
  formatMarginPercent,
  filterCatalog,
  getPriceStatus,
  marketTargetItemType,
  marketTargetTitle,
  type CatalogFilters,
} from './catalog.js';
import { Money, ProfitBadge, StatusPanel } from './components.js';
import { createApiClient } from './apiClient.js';
import { RecipePage } from './RecipePage.js';
import { ItemTooltip } from './ItemTooltip.js';
import { successfulAtFormatter } from './failureStates.js';
import { marketClient } from './marketClient.js';

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
  'quiver',
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
  const [marketTargets, setMarketTargets] = useState<
    MarketTargetInput[] | null
  >(null);
  const [marketLibraryError, setMarketLibraryError] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const entries = response?.data?.entries ?? [];
  const targets = marketTargets ?? [];
  const categories = useMemo(
    () =>
      [
        ...new Set([
          ...itemTypes,
          ...entries.map(({ recipe }) => recipe.category),
          ...targets.map(({ slot }) => marketTargetItemType(slot)),
        ]),
      ].sort(),
    [entries, targets],
  );
  const filteredEntries = useMemo(
    () => filterCatalog(entries, filters),
    [entries, filters],
  );
  const filteredTargets = useMemo(
    () => filterMarketTargets(targets, filters),
    [targets, filters],
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
    marketClient
      .starterLibrary()
      .then((profiles) => {
        if (active) setMarketTargets(profiles);
      })
      .catch(() => {
        if (active) {
          setMarketTargets([]);
          setMarketLibraryError(true);
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

  return (
    <>
      <section className="catalog-heading" aria-labelledby="catalog-heading">
        <div>
          <h1 id="catalog-heading">Crafting Targets</h1>
        </div>
      </section>

      {loadError ? (
        <StatusPanel tone="danger" title="Recipes unavailable">
          The recipe list could not be loaded. Try again when the service is
          available.
        </StatusPanel>
      ) : null}

      {marketLibraryError ? (
        <p className="handbook-empty" role="alert">
          Market target library could not be loaded.
        </p>
      ) : null}

      {!response && !loadError ? (
        <StatusPanel tone="info" title="Loading recipes" />
      ) : marketTargets === null && entries.length === 0 ? (
        <StatusPanel tone="info" title="Loading market targets" />
      ) : marketTargets !== null &&
        entries.length === 0 &&
        targets.length === 0 &&
        !filters.search.trim() &&
        filters.category === 'all' ? (
        <section className="empty-state" aria-labelledby="empty-heading">
          <h2 id="empty-heading">No crafting targets available</h2>
          <p>Recipes and market targets will appear here.</p>
        </section>
      ) : (
        <>
          <section
            className="handbook-controls"
            aria-label="Crafting target search and item types"
          >
            <label className="catalog-search">
              <span className="visually-hidden">Search items</span>
              <input
                type="search"
                placeholder="Search items or targets…"
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

          {filteredEntries.length + filteredTargets.length === 0 ? (
            <p className="handbook-empty">No items match these filters.</p>
          ) : (
            <section
              className="recipe-table-wrap"
              aria-label="Crafting targets"
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
                  {filteredTargets.map((target) => (
                    <MarketTargetRow
                      key={`${target.name}:${target.slot}:${target.baseTypes.join('|')}`}
                      target={target}
                    />
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
          : formatMarginPercent(evaluation.marginPercent)}
      </td>
      <td>{evaluation.confidence ?? 'Unavailable'}</td>
      <td>
        {getPriceStatus(evaluation.status)}
        {evaluation.lastSuccessfulAt ? (
          <small>
            {' '}
            <time dateTime={evaluation.lastSuccessfulAt}>
              {successfulAtFormatter.format(
                new Date(evaluation.lastSuccessfulAt),
              )}
            </time>
          </small>
        ) : null}
      </td>
    </tr>
  );
}

function MarketTargetRow({ target }: { target: MarketTargetInput }) {
  const source = target.sources[0];
  return (
    <tr>
      <td>
        <div className="recipe-table__identity recipe-table__target">
          <div>
            <strong>{marketTargetTitle(target)}</strong>
            <small>
              Market target · {target.league} {target.patch}
            </small>
            {source ? (
              <a href={source.url} rel="noreferrer" target="_blank">
                Source · {source.title}
              </a>
            ) : null}
          </div>
        </div>
      </td>
      <td className="recipe-table__type">
        {marketTargetItemType(target.slot).replaceAll('-', ' ')}
      </td>
      <td>{target.baseTypes.join(' / ')}</td>
      <td>Not specified</td>
      <td>Not estimated</td>
      <td>Not priced</td>
      <td>Not estimated</td>
      <td>Not estimated</td>
      <td>Unverified</td>
      <td>Target profile</td>
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
