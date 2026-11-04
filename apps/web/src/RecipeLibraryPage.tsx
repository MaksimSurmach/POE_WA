import type { CatalogEntry } from '@poe-worksmith/contracts';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { createApiClient } from './apiClient.js';
import { filterCatalog } from './catalog.js';
import { StatusPanel } from './components.js';
import { ItemTooltip } from './ItemTooltip.js';

const apiClient = createApiClient();

export function RecipeLibraryPage() {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    apiClient.getCatalog().then(
      (response) => {
        if (active) setEntries(response.data?.entries ?? []);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return (
    <>
      <section className="catalog-heading">
        <div>
          <h1>Crafting recipes</h1>
          <p>
            Browse targets, materials and crafting steps. Recipes stay here
            regardless of market profitability.
          </p>
        </div>
      </section>
      {failed ? (
        <StatusPanel tone="danger" title="Recipes unavailable">
          Reload to try again.
        </StatusPanel>
      ) : entries === null ? (
        <StatusPanel tone="info" title="Loading recipes" />
      ) : (
        <RecipeLibrary entries={entries} />
      )}
    </>
  );
}

export function RecipeLibrary({ entries }: { entries: CatalogEntry[] }) {
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  const category = params.get('category') ?? 'all';
  const filtered = filterCatalog(entries, { search, category, sort: 'title' });
  const categories = [
    ...new Set(entries.map(({ recipe }) => recipe.category)),
  ].sort();
  function update(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }
  return (
    <>
      <section
        className="handbook-controls recipe-library-filters"
        aria-label="Recipe filters"
      >
        <label className="catalog-search catalog-filter">
          <span>Recipe name or target</span>
          <input
            type="search"
            value={search}
            placeholder="Search recipes…"
            onChange={(event) => update('search', event.target.value)}
          />
        </label>
        <label className="catalog-filter">
          <span>Item class</span>
          <select
            value={category}
            onChange={(event) => update('category', event.target.value)}
          >
            <option value="all">All classes</option>
            {categories.map((name) => (
              <option key={name} value={name}>
                {name.replaceAll('-', ' ')}
              </option>
            ))}
          </select>
        </label>
      </section>
      <div className="catalog-results">
        <span role="status">
          {filtered.length} of {entries.length} recipes
        </span>
        <button type="button" onClick={() => setParams({}, { replace: true })}>
          Reset filters
        </button>
      </div>
      <ul className="recipe-library">
        {filtered.map(({ recipe, itemPreview }) => (
          <li key={recipe.id}>
            {itemPreview ? <ItemTooltip item={itemPreview} /> : null}
            <div>
              <h2>
                <Link to={`/recipes/${encodeURIComponent(recipe.id)}`}>
                  {recipe.title}
                </Link>
              </h2>
              <p className="recipe-library__method">
                {recipe.category.replaceAll('-', ' ')} · {recipe.craftMethod}
              </p>
              <p>{recipe.summary}</p>
              <Link to={`/recipes/${encodeURIComponent(recipe.id)}`}>
                Materials and steps ›
              </Link>
            </div>
          </li>
        ))}
      </ul>
      {!filtered.length ? (
        <StatusPanel tone="info" title="No matching recipes">
          Try another name or item class.
        </StatusPanel>
      ) : null}
    </>
  );
}
