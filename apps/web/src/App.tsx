import { SelectedTarget } from './SelectedTarget.js';
import { formatTimestamp } from './dateTime.js';
import { WorkspaceShell as AppShell } from './WorkspaceShell.js';
import { CatalogOverview } from './CatalogOverview.js';
import { Button, Input, NativeSelect } from './ui.js';
import type {
  CatalogResponse,
  CurrentLeagueResponse,
} from '@poe-worksmith/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Route, Routes, useSearchParams } from 'react-router-dom';
import { WorkspaceLink as Link } from './workspaceNavigation.js';

import {
  defaultCatalogFilters,
  filterCatalog,
  readCatalogFilters,
  type CatalogFilters,
} from './catalog.js';
import { StatusPanel } from './components.js';
import { CatalogTable } from './CatalogTable.js';
import { CollectorControls } from './CollectorControls.js';
import { HomeSettings } from './HomeSettings.js';
import { collectorRequestTimeoutMs, createApiClient } from './apiClient.js';
import { RecipePage } from './RecipePage.js';
import { MarketTrendsPage } from './MarketTrendsPage.js';
import { RecipeLibraryPage } from './RecipeLibraryPage.js';
import { PohxRecipePage } from './PohxRecipePage.js';
import { FactoryPage } from './FactoryPage.js';
import { CollectorReadinessReport } from './MarketReadiness.js';

const apiClient = createApiClient();

function CatalogRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(
    () => readCatalogFilters(searchParams),
    [searchParams],
  );
  function setFilters(
    next: CatalogFilters | ((current: CatalogFilters) => CatalogFilters),
  ) {
    const value = typeof next === 'function' ? next(filters) : next;
    const nextParams = new URLSearchParams(searchParams);
    for (const key of [
      'category',
      'search',
      'sort',
      'view',
      'tag',
      'direction',
      'minProfit',
      'profitCurrency',
      'minRoi',
    ])
      nextParams.delete(key);
    for (const [key, item] of Object.entries(value)) {
      if (
        item !== undefined &&
        item !== '' &&
        item !== 'all' &&
        item !== defaultCatalogFilters[key as keyof CatalogFilters]
      )
        nextParams.set(key, String(item));
    }
    setSearchParams(nextParams, { replace: true });
  }
  const [response, setResponse] = useState<CatalogResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [league, setLeague] = useState<CurrentLeagueResponse['data'] | null>(
    null,
  );
  const collectorMode = response?.data?.pipeline === 'collector';
  const catalogLeague = response?.data?.league;
  const [catalogRevision, setCatalogRevision] = useState(0);
  const reloadCatalog = useCallback(
    () => setCatalogRevision((value) => value + 1),
    [],
  );
  const entries = response?.data?.entries ?? [];
  const marketUpdatedAt = entries
    .map(({ evaluation, snapshot }) =>
      collectorMode ? evaluation.source?.capturedAt : snapshot?.capturedAt,
    )
    .filter((timestamp): timestamp is string => Boolean(timestamp))
    .sort()
    .at(-1);
  const categories = useMemo(
    () =>
      [...new Set([...entries.map(({ recipe }) => recipe.category)])].sort(),
    [entries],
  );
  const effectiveFilters =
    filters.sort === 'profit' &&
    !searchParams.has('sort') &&
    entries.every(({ evaluation }) => evaluation.profit === null)
      ? { ...filters, sort: 'freshness' as const }
      : filters;
  const filteredEntries = useMemo(
    () => filterCatalog(entries, effectiveFilters),
    [entries, effectiveFilters],
  );
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let refreshLeague = true;
    let collector = catalogRevision > 0;
    const readLeague = () =>
      apiClient
        .getCurrentLeague(AbortSignal.timeout(collectorRequestTimeoutMs))
        .catch(() => null);
    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        const leagueRead = refreshLeague ? readLeague() : undefined;
        const catalog = await apiClient.getCatalog(
          collector
            ? AbortSignal.timeout(collectorRequestTimeoutMs)
            : undefined,
        );
        if (!active) return;
        collector = catalog.data?.pipeline === 'collector';
        refreshLeague = collector;
        if (collector) {
          const currentLeague = await (leagueRead ?? readLeague());
          if (!active) return;
          setLeague(currentLeague?.data ?? null);
        } else if (leagueRead) {
          void leagueRead.then((currentLeague) => {
            if (active && !collector) setLeague(currentLeague?.data ?? null);
          });
        }
        setResponse(catalog);
        setLoadError(false);
      } catch {
        if (active) setLoadError(true);
      } finally {
        inFlight = false;
      }
    }
    void load();
    // Re-read server freshness even when nobody requests a manual refresh.
    let idleTicks = 0;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      idleTicks++;
      if (collector && idleTicks < 4) return;
      idleTicks = 0;
      void load();
    }, 30_000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [catalogRevision]);

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
          <h1 id="catalog-heading">Что крафтить</h1>
          <p>
            {catalogLeague === null
              ? 'League unavailable'
              : catalogLeague && catalogLeague.id !== league?.id
                ? `${catalogLeague.name} · Market observations`
                : league
                  ? `${league.discovery === 'confirmed' ? '' : 'Last known league: '}${league.name} · PC market`
                  : 'League unavailable'}
          </p>
          {marketUpdatedAt ? (
            <p>
              Market updated{' '}
              <time dateTime={marketUpdatedAt}>
                {formatTimestamp(marketUpdatedAt)}
              </time>
            </p>
          ) : null}
        </div>
      </section>

      {loadError ? (
        <StatusPanel tone="danger" title="Рецепты недоступны">
          The recipe list could not be loaded. Try again when the service is
          available.
          <Button type="button" onClick={reloadCatalog}>
            Повторить загрузку
          </Button>
        </StatusPanel>
      ) : null}

      {loadError ? null : !response ? (
        <StatusPanel tone="info" title="Загрузка рецептов" />
      ) : entries.length === 0 &&
        !filters.search.trim() &&
        filters.category === 'all' ? (
        <section className="empty-state" aria-labelledby="empty-heading">
          <h2 id="empty-heading">Нет доступных целей крафта</h2>
          <p>Здесь появятся доступные рецепты крафта.</p>
        </section>
      ) : (
        <>
          <CatalogOverview entries={entries} />
          <section
            className="handbook-controls"
            aria-label="Crafting target search and item types"
          >
            <label className="catalog-search catalog-filter">
              <span>Название предмета</span>
              <Input
                type="search"
                placeholder="Поиск предметов и целей…"
                value={filters.search}
                onChange={(event) => updateFilter('search', event.target.value)}
              />
            </label>
            <details
              className="catalog-advanced-filters"
              open={Boolean(
                filters.category !== 'all' ||
                (filters.view && filters.view !== 'all') ||
                filters.minProfit ||
                filters.minRoi ||
                (filters.tag && filters.tag !== 'all'),
              )}
            >
              <summary>Фильтры</summary>
              <label className="catalog-filter">
                <span>Класс предмета</span>
                <NativeSelect
                  value={filters.category}
                  onChange={(event) =>
                    updateFilter('category', event.target.value)
                  }
                >
                  <option value="all">Все классы</option>
                  {categories.map((category) => (
                    <option key={category} value={category}>
                      {category.replaceAll('-', ' ')}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="catalog-filter">
                <span>Показать цели</span>
                <NativeSelect
                  value={filters.view ?? 'all'}
                  onChange={(event) =>
                    updateFilter(
                      'view',
                      event.target.value as NonNullable<CatalogFilters['view']>,
                    )
                  }
                >
                  <option value="all">Все цели</option>
                  <option value="priced">С ценами</option>
                  <option value="activity">Исчезновения объявлений</option>
                  <option value="estimated">Оценки прибыли</option>
                </NativeSelect>
              </label>

              <label className="catalog-filter">
                <span>Tag</span>
                <NativeSelect
                  value={filters.tag ?? 'all'}
                  onChange={(e) => updateFilter('tag', e.target.value)}
                >
                  <option value="all">Все теги</option>
                  {[...new Set(entries.flatMap((e) => e.recipe.tags))]
                    .sort()
                    .map((tag) => (
                      <option key={tag}>{tag}</option>
                    ))}
                </NativeSelect>
              </label>

              <div className="catalog-filter">
                <label htmlFor="minimum-profit">
                  Мин. разница с asking price (
                  {filters.profitCurrency === 'divine' ? 'div' : 'c'})
                </label>
                <div className="catalog-profit-filter">
                  <Input
                    id="minimum-profit"
                    type="number"
                    step="any"
                    placeholder="Any"
                    value={filters.minProfit ?? ''}
                    onChange={(event) =>
                      updateFilter('minProfit', event.target.value)
                    }
                  />
                  <NativeSelect
                    aria-label="Валюта оценки"
                    value={filters.profitCurrency ?? 'chaos'}
                    onChange={(event) =>
                      updateFilter(
                        'profitCurrency',
                        event.target.value as 'chaos' | 'divine',
                      )
                    }
                  >
                    <option value="chaos">c</option>
                    <option value="divine">div</option>
                  </NativeSelect>
                </div>
              </div>
              <label className="catalog-filter">
                <span>Мин. ROI (%)</span>
                <Input
                  type="number"
                  step="any"
                  placeholder="Any"
                  value={filters.minRoi ?? ''}
                  onChange={(event) =>
                    updateFilter('minRoi', event.target.value)
                  }
                />
              </label>
            </details>
          </section>

          <div className="catalog-results">
            <span role="status">
              {filteredEntries.length} из {entries.length} рецептов
            </span>
            {Object.entries(filters).some(
              ([key, value]) =>
                value !== undefined &&
                value !== defaultCatalogFilters[key as keyof CatalogFilters],
            ) ? (
              <Button
                type="button"
                onClick={() => setFilters(defaultCatalogFilters)}
              >
                Сбросить фильтры
              </Button>
            ) : null}
          </div>
          <CatalogTable
            entries={filteredEntries}
            filters={effectiveFilters}
            onSort={(sort) =>
              setFilters((current) => ({
                ...current,
                sort,
                direction:
                  (effectiveFilters.sort ?? 'title') === sort
                    ? (effectiveFilters.direction ??
                        (['title', 'category', 'cost'].includes(sort)
                          ? 'asc'
                          : 'desc')) === 'asc'
                      ? 'desc'
                      : 'asc'
                    : ['title', 'category', 'cost'].includes(sort)
                      ? 'asc'
                      : 'desc',
              }))
            }
          />
          <p className="catalog-price-note" id="catalog-price-note">
            Цены объявлений и их исчезновения — наблюдения, не подтверждённые
            продажи. Откройте цель для материалов, шагов и источников.{' '}
            <Link to="/market">Сравнить цены на рынке</Link>.
          </p>
        </>
      )}

      {(catalogLeague ?? league)?.name === 'Standard' ? (
        <p className="catalog-price-note">
          Standard is the permanent market. The collector switches to a
          temporary PC league once both GGG and poe.ninja list it.
        </p>
      ) : null}
      {collectorMode ? (
        <p className="catalog-price-note">
          <Link to="/settings">Состояние сбора и настройки</Link>
        </p>
      ) : null}
    </>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<CraftRoute />} />
        <Route path="recipes" element={<RecipeCollectionRoute />} />
        <Route path="recipes/pohx/:guideId" element={<PohxRecipePage />} />
        <Route path="recipes/:recipeId" element={<RecipePage />} />
        <Route path="factory" element={<FactoryPage />} />
        <Route path="market" element={<MarketTrendsPage />} />
        <Route path="settings" element={<CollectionSettingsPage />} />
        <Route
          path="*"
          element={<StatusPanel tone="warning" title="Страница не найдена" />}
        />
      </Route>
    </Routes>
  );
}

function CollectionSettingsPage() {
  const [params] = useSearchParams();
  const data = params.get('view') === 'data';
  return (
    <>
      <header className="catalog-heading">
        <div>
          <h1>{data ? 'Данные и источники' : 'Настройки'}</h1>
          <p>Состояние коллектора и срок актуальности сохранённых цен.</p>
        </div>
      </header>
      <CollectorControls />
      {data ? <CollectorReadinessReport /> : <HomeSettings initiallyOpen />}
    </>
  );
}

function CraftRoute() {
  const [params] = useSearchParams();
  return ['item', 'budget'].includes(params.get('view') ?? '') ? (
    <SelectedTarget />
  ) : (
    <CatalogRoute />
  );
}
function RecipeCollectionRoute() {
  const [params] = useSearchParams();
  return ['recipe', 'steps', 'methods', 'materials'].includes(
    params.get('view') ?? '',
  ) ? (
    <SelectedTarget />
  ) : (
    <RecipeLibraryPage />
  );
}
