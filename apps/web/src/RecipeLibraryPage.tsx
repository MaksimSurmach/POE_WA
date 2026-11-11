import { Button, Input, NativeSelect } from './ui.js';
import type { CatalogEntry } from '@poe-worksmith/contracts';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { createApiClient } from './apiClient.js';
import { filterCatalog } from './catalog.js';
import { StatusPanel } from './components.js';
import { ItemTooltip } from './ItemTooltip.js';
import { filterPohxGuides, pohxGuides } from './pohxGuides.js';

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
          Market targets could not be loaded. Pohx guides remain available
          below.
        </StatusPanel>
      ) : entries === null ? (
        <StatusPanel tone="info" title="Loading recipes" />
      ) : null}
      <RecipeLibrary entries={entries ?? []} />
    </>
  );
}

export function RecipeLibrary({ entries }: { entries: CatalogEntry[] }) {
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  const category = params.get('category') ?? 'all';
  const source = params.get('source') ?? 'all';
  const filtered =
    source === 'pohx'
      ? []
      : filterCatalog(entries, { search, category, sort: 'title' });
  const guides = source === 'market' ? [] : filterPohxGuides(search, category);
  const categories = [
    ...new Set([
      ...entries.map(({ recipe }) => recipe.category),
      ...pohxGuides.map((g) => g.category),
    ]),
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
          <Input
            type="search"
            value={search}
            placeholder="Search recipes…"
            onChange={(event) => update('search', event.target.value)}
          />
        </label>
        <label className="catalog-filter">
          <span>Item class</span>
          <NativeSelect
            value={category}
            onChange={(event) => update('category', event.target.value)}
          >
            <option value="all">All classes</option>
            {categories.map((name) => (
              <option key={name} value={name}>
                {name.replaceAll('-', ' ')}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="catalog-filter">
          <span>Source</span>
          <NativeSelect
            value={source}
            onChange={(e) => update('source', e.target.value)}
          >
            <option value="all">All recipes</option>
            <option value="market">Market targets</option>
            <option value="pohx">Pohx / Convay</option>
          </NativeSelect>
        </label>
      </section>
      <div className="catalog-results">
        <span role="status">
          {filtered.length + guides.length} of{' '}
          {entries.length + pohxGuides.length} recipes and guides
        </span>
        <Button type="button" onClick={() => setParams({}, { replace: true })}>
          Reset filters
        </Button>
      </div>
      <ul className="recipe-library">
        {guides.map((guide) => (
          <li key={`pohx-${guide.id}`}>
            <span className="recipe-library__guide-mark" aria-hidden="true">
              POHX
            </span>
            <div>
              <h2>
                <Link to={`/recipes/pohx/${guide.id}`}>{guide.title}</Link>
              </h2>
              <p className="recipe-library__method">
                {guide.category.replaceAll('-', ' ')} · Pohx / Convay ·{' '}
                {guide.workInProgress
                  ? 'Source work in progress'
                  : 'Spending scenario'}
              </p>
              <p>{guide.summary}</p>
              <Link to={`/recipes/pohx/${guide.id}`}>
                {guide.workInProgress
                  ? 'View source status'
                  : 'Steps and cost calculator'}{' '}
                ›
              </Link>
            </div>
          </li>
        ))}
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
      {!filtered.length && !guides.length ? (
        <StatusPanel tone="info" title="No matching recipes">
          Try another name or item class.
        </StatusPanel>
      ) : null}
    </>
  );
}
