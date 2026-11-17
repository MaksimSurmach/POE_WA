import { Button, Input, NativeSelect } from './ui.js';
import type { CatalogEntry } from '@poe-worksmith/contracts';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { WorkspaceLink as Link } from './workspaceNavigation.js';

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
          <h1>Каталог рецептов</h1>
          <p>
            Цели, материалы и инструкции крафта. Каталог включает рецепты
            независимо от рыночной оценки.
          </p>
        </div>
      </section>
      {failed ? (
        <StatusPanel tone="danger" title="Рецепты недоступны">
          Не удалось загрузить рыночные цели. Гайды Pohx доступны ниже.
        </StatusPanel>
      ) : entries === null ? (
        <StatusPanel tone="info" title="Загрузка рецептов" />
      ) : null}
      <RecipeLibrary entries={entries ?? []} />
    </>
  );
}

export function RecipeLibrary({ entries }: { entries: CatalogEntry[] }) {
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  const category = params.get('category') ?? 'all';
  const source =
    params.get('view') === 'guides' ? 'pohx' : (params.get('source') ?? 'all');
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
          <span>Название рецепта или цель</span>
          <Input
            type="search"
            value={search}
            placeholder="Поиск рецептов…"
            onChange={(event) => update('search', event.target.value)}
          />
        </label>
        <label className="catalog-filter">
          <span>Класс предмета</span>
          <NativeSelect
            value={category}
            onChange={(event) => update('category', event.target.value)}
          >
            <option value="all">Все классы</option>
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
            <option value="all">Все рецепты</option>
            <option value="market">Рыночные цели</option>
            <option value="pohx">Pohx / Convay</option>
          </NativeSelect>
        </label>
      </section>
      <div className="catalog-results">
        <span role="status">
          {filtered.length + guides.length} of{' '}
          {entries.length + pohxGuides.length} recipes and guides
        </span>
        <Button
          type="button"
          onClick={() => {
            const next = new URLSearchParams(params);
            for (const key of ['search', 'category', 'source'])
              next.delete(key);
            setParams(next, { replace: true });
          }}
        >
          Сбросить фильтры
        </Button>
      </div>
      <p className="catalog-price-note">
        Рыночные цели содержат собранные цены. Гайды Pohx / Convay включают
        ручные калькуляторы расходов, без подтверждённой оценки прибыли.
      </p>
      <ul className="recipe-library">
        {filtered.length ? (
          <li className="recipe-library__heading">
            <h2>Рыночные рецепты</h2>
            <span>Materials, steps and collected asks</span>
          </li>
        ) : null}
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
                Материалы и шаги ›
              </Link>
            </div>
          </li>
        ))}
        {guides.length ? (
          <li className="recipe-library__heading">
            <h2>Гайды Pohx / Convay</h2>
            <span>Procedures and manual budget calculators</span>
          </li>
        ) : null}
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
                  ? 'Автор ещё готовит материал'
                  : 'Сценарий расходов'}
              </p>
              <p>{guide.summary}</p>
              <Link to={`/recipes/pohx/${guide.id}`}>
                {guide.workInProgress
                  ? 'Посмотреть статус источника'
                  : 'Шаги и калькулятор затрат'}{' '}
                ›
              </Link>
            </div>
          </li>
        ))}
      </ul>
      {!filtered.length && !guides.length ? (
        <StatusPanel tone="info" title="Нет подходящих рецептов">
          Try another name or item class.
        </StatusPanel>
      ) : null}
    </>
  );
}
