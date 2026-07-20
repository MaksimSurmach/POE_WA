import { useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, Route, Routes } from 'react-router-dom';

import {
  defaultCatalogFilters,
  filterAndSortCatalog,
  snapshotAgeSeconds,
  type CatalogFilters,
} from './catalog.js';
import {
  EvaluationStatus,
  FreshnessIndicator,
  ListingAge,
  Money,
  ProfitBadge,
  StatusPanel,
  Tag,
} from './components.js';
import {
  activeCycle,
  catalogFixtures,
  publishedCycle,
} from './mocks/catalog.js';
import { RecipePage } from './RecipePage.js';

const mockNow = '2026-07-20T00:04:00.000Z';
const categories = [
  ...new Set(catalogFixtures.map(({ recipe }) => recipe.category)),
].sort();
const methods = [
  ...new Set(catalogFixtures.map(({ recipe }) => recipe.craftMethod)),
].sort();
const tags = [
  ...new Set(catalogFixtures.flatMap(({ recipe }) => recipe.tags)),
].sort();

function AppShell() {
  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link className="brand" to="/" aria-label="POE Worksmith home">
            <span>POE</span> Worksmith
          </Link>
          <nav aria-label="Primary navigation">
            <NavLink
              className={({ isActive }) =>
                isActive ? 'nav-link is-active' : 'nav-link'
              }
              to="/"
              end
            >
              Catalog
            </NavLink>
          </nav>
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
  const entries = useMemo(
    () => filterAndSortCatalog(catalogFixtures, filters),
    [filters],
  );
  const publishedAge = publishedCycle.publishedAt
    ? Math.max(
        0,
        (Date.parse(mockNow) - Date.parse(publishedCycle.publishedAt)) / 1000,
      )
    : 0;

  function updateFilter<K extends keyof CatalogFilters>(
    key: K,
    value: CatalogFilters[K],
  ) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  if (catalogFixtures.length === 0) {
    return (
      <section className="empty-state" aria-labelledby="empty-catalog-heading">
        <h1 id="empty-catalog-heading">Catalog is empty</h1>
        <p>Add a validated recipe to publish the first catalog.</p>
      </section>
    );
  }

  return (
    <>
      <section className="catalog-heading" aria-labelledby="catalog-heading">
        <div>
          <h1 id="catalog-heading">Craft catalog</h1>
          <p>Compare expected cost, sale price, and market freshness.</p>
        </div>
        <div
          className="catalog-meta"
          aria-label="Catalog publication and refresh status"
        >
          <p>
            Published <ListingAge seconds={publishedAge} />
          </p>
          <label>
            <span>
              Refresh {activeCycle.completedRecipes} of{' '}
              {activeCycle.totalRecipes}
            </span>
            <progress
              aria-label="Current refresh progress"
              max={activeCycle.totalRecipes}
              value={activeCycle.completedRecipes}
            />
          </label>
        </div>
      </section>

      <StatusPanel tone="warning" title="Published catalog contains stale data">
        Previous successful values remain visible while providers recover.
      </StatusPanel>

      <details className="catalog-filters" open>
        <summary>Filters and sorting</summary>
        <div className="catalog-filters__grid">
          <Filter label="Search">
            <input
              type="search"
              placeholder="Search recipes"
              value={filters.search}
              onChange={(event) => updateFilter('search', event.target.value)}
            />
          </Filter>
          <Filter label="Category">
            <select
              value={filters.category}
              onChange={(event) => updateFilter('category', event.target.value)}
            >
              <option value="all">All categories</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
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
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </Filter>
          <Filter label="Craft method">
            <select
              value={filters.method}
              onChange={(event) => updateFilter('method', event.target.value)}
            >
              <option value="all">All methods</option>
              {methods.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>
          </Filter>
          <Filter label="Budget">
            <select
              value={filters.budget}
              onChange={(event) => updateFilter('budget', event.target.value)}
            >
              <option value="all">Any budget</option>
              <option value="2">Up to 2 div</option>
              <option value="5">Up to 5 div</option>
              <option value="10">Up to 10 div</option>
            </select>
          </Filter>
          <Filter label="Status">
            <select
              value={filters.status}
              onChange={(event) => updateFilter('status', event.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="success">Ready</option>
              <option value="stale">Stale</option>
              <option value="loading">Loading</option>
              <option value="partial">Partial</option>
              <option value="error">Error</option>
            </select>
          </Filter>
          <Filter label="Sort by">
            <select
              value={filters.sort}
              onChange={(event) =>
                updateFilter(
                  'sort',
                  event.target.value as CatalogFilters['sort'],
                )
              }
            >
              <option value="profit">Profit: high to low</option>
              <option value="margin">Margin: high to low</option>
              <option value="capital">Capital: low to high</option>
              <option value="freshness">Freshness: newest first</option>
            </select>
          </Filter>
          <button
            className="clear-filters"
            type="button"
            onClick={() => setFilters(defaultCatalogFilters)}
          >
            Clear filters
          </button>
        </div>
      </details>

      {entries.length === 0 ? (
        <section className="empty-state" aria-labelledby="no-results-heading">
          <h2 id="no-results-heading">No recipes match these filters</h2>
          <p>Clear the filters to return to the published catalog.</p>
          <button
            type="button"
            onClick={() => setFilters(defaultCatalogFilters)}
          >
            Clear filters
          </button>
        </section>
      ) : (
        <section className="catalog-table" aria-label="Ranked recipe catalog">
          <div className="catalog-table__header" aria-hidden="true">
            <span>Recipe</span>
            <span>Category</span>
            <span>Capital</span>
            <span>Cost</span>
            <span>Sale</span>
            <span>Profit</span>
            <span>Margin</span>
            <span>Listings</span>
            <span>Freshness</span>
            <span>Status</span>
            <span />
          </div>
          {entries.map((entry) => (
            <CatalogRow entry={entry} key={entry.recipe.id} />
          ))}
        </section>
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

function CatalogRow({ entry }: { entry: (typeof catalogFixtures)[number] }) {
  const { evaluation, recipe, snapshot } = entry;
  const ageSeconds = snapshotAgeSeconds(entry, mockNow);

  return (
    <Link className="catalog-row" to={`/recipes/${recipe.id}`}>
      <div className="catalog-row__identity">
        <strong>{recipe.title}</strong>
        <span className="tag-list" aria-label={`${recipe.title} tags`}>
          {recipe.tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </span>
      </div>
      <CatalogCell label="Category">{recipe.category}</CatalogCell>
      <CatalogCell label="Capital">
        <Money price={recipe.minimumCapital} />
      </CatalogCell>
      <CatalogCell label="Cost">
        <Money price={evaluation.expectedCraftCost} />
      </CatalogCell>
      <CatalogCell label="Sale">
        <Money price={evaluation.estimatedSalePrice} />
      </CatalogCell>
      <CatalogCell label="Profit">
        {evaluation.profit ? (
          <ProfitBadge
            amount={evaluation.profit.amount}
            currency={evaluation.profit.currency}
          />
        ) : (
          '—'
        )}
      </CatalogCell>
      <CatalogCell label="Margin">
        {evaluation.marginPercent === null
          ? '—'
          : `${evaluation.marginPercent}%`}
      </CatalogCell>
      <CatalogCell label="Listings">
        {snapshot?.totalResults ?? '—'}
      </CatalogCell>
      <CatalogCell label="Freshness">
        {ageSeconds === null ? (
          '—'
        ) : (
          <FreshnessIndicator ageSeconds={ageSeconds} />
        )}
      </CatalogCell>
      <CatalogCell label="Status">
        <EvaluationStatus status={evaluation.status} />
      </CatalogCell>
      <span className="catalog-row__action">View recipe</span>
    </Link>
  );
}

function CatalogCell({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <span className="catalog-cell">
      <span className="catalog-cell__label">{label}</span>
      <span className="catalog-cell__value">{children}</span>
    </span>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<CatalogRoute />} />
        <Route path="recipes/:recipeId" element={<RecipePage />} />
      </Route>
    </Routes>
  );
}
