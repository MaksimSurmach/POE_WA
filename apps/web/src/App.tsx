import type {
  CatalogResponse,
  CurrentLeagueResponse,
} from '@poe-worksmith/contracts';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  Link,
  NavLink,
  Outlet,
  Route,
  Routes,
  useSearchParams,
} from 'react-router-dom';

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

const apiClient = createApiClient();

function AppShell() {
  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link className="brand" to="/" aria-label="Worksmith Handbook home">
            <span>Worksmith</span> Handbook
          </Link>
          <nav aria-label="Primary" className="app-nav">
            <NavLink
              className={({ isActive }) =>
                isActive ? 'nav-link is-active' : 'nav-link'
              }
              end
              to="/"
            >
              Craft Opportunities
            </NavLink>
            <NavLink
              className={({ isActive }) =>
                isActive ? 'nav-link is-active' : 'nav-link'
              }
              to="/recipes"
            >
              Recipes
            </NavLink>
            <NavLink
              className={({ isActive }) =>
                isActive ? 'nav-link is-active' : 'nav-link'
              }
              to="/market"
            >
              Market trends
            </NavLink>
            <NavLink
              className={({ isActive }) =>
                isActive ? 'nav-link is-active' : 'nav-link'
              }
              to="/factory"
            >
              My Factory
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
  const [operatorToken, setOperatorToken] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(
    () => readCatalogFilters(searchParams),
    [searchParams],
  );
  function setFilters(
    next: CatalogFilters | ((current: CatalogFilters) => CatalogFilters),
  ) {
    const value = typeof next === 'function' ? next(filters) : next;
    setSearchParams(
      Object.fromEntries(
        Object.entries(value).filter(
          ([key, item]) =>
            item !== undefined &&
            item !== '' &&
            item !== 'all' &&
            item !== defaultCatalogFilters[key as keyof CatalogFilters],
        ),
      ),
      { replace: true },
    );
  }
  const [response, setResponse] = useState<CatalogResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [league, setLeague] = useState<CurrentLeagueResponse['data'] | null>(
    null,
  );
  const refreshBaseline = useRef<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState('');
  const collectorMode = response?.data?.pipeline === 'collector';
  const legacyMode = response !== null && !collectorMode;
  const [catalogRevision, setCatalogRevision] = useState(0);
  const reloadCatalog = useCallback(
    () => setCatalogRevision((value) => value + 1),
    [],
  );
  useEffect(() => {
    if (!legacyMode) return;
    let active = true;
    apiClient
      .getRefreshFreshness()
      .then((r) => {
        if (active && r.data.active) {
          refreshBaseline.current = r.data.published?.id ?? null;
          setRefreshing(true);
          setRefreshMessage('Price refresh running.');
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [legacyMode]);
  useEffect(() => {
    if (!legacyMode || !refreshing) return;
    let active = true;
    const queuedAt = Date.now();
    const poll = setInterval(() => {
      apiClient
        .getRefreshFreshness()
        .then(async (r) => {
          if (!active) return;
          if (
            (r.data.lastAttempt?.id ?? null) === refreshBaseline.current &&
            Date.now() - queuedAt > 60_000
          ) {
            setRefreshing(false);
            setRefreshMessage(
              'Refresh has not started. Check worker status and try again.',
            );
            return;
          }
          const cycle = r.data.active ?? r.data.lastAttempt;
          if (cycle)
            setRefreshMessage(
              `${r.data.state}: ${cycle.completedQueries + cycle.failedQueries}/${cycle.totalQueries} queries`,
            );
          if (
            ['published', 'failed'].includes(r.data.state) &&
            r.data.lastAttempt?.id !== refreshBaseline.current
          ) {
            const [catalog, currentLeague] = await Promise.all([
              apiClient.getCatalog(),
              apiClient.getCurrentLeague(),
            ]);
            if (active) {
              setResponse(catalog);
              setLeague(currentLeague.data);
              setRefreshing(false);
            }
          }
        })
        .catch(() => {
          if (active) {
            setRefreshing(false);
            setRefreshMessage('Price refresh status unavailable.');
          }
        });
    }, 2000);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [legacyMode, refreshing]);
  async function refreshPrices() {
    setRefreshing(true);
    setRefreshMessage('Requesting price refresh…');
    try {
      const freshness = (await apiClient.getRefreshFreshness()).data;
      refreshBaseline.current = freshness.active
        ? (freshness.published?.id ?? null)
        : (freshness.lastAttempt?.id ?? null);
      if (freshness.active) {
        setRefreshMessage('A price refresh is already running.');
        return;
      }
      const result = await apiClient.triggerPriceRefresh();
      if (!result.data.accepted) refreshBaseline.current = null;
      setRefreshMessage(
        result.data.accepted
          ? 'Price refresh queued.'
          : 'A refresh is already queued or running.',
      );
    } catch {
      setRefreshing(false);
      setRefreshMessage(
        'Price refresh unavailable. Check the server connection and configured source access.',
      );
    }
  }
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
  const filteredEntries = useMemo(
    () => filterCatalog(entries, filters),
    [entries, filters],
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
          <h1 id="catalog-heading">Worksmith Handbook</h1>
          <p>
            {league
              ? `${league.discovery === 'confirmed' ? '' : 'Last known league: '}${league.name} · Last checked ${new Date(league.syncedAt).toLocaleString('en-US')}`
              : 'League unavailable'}
          </p>
          {marketUpdatedAt ? (
            <p>
              Market updated{' '}
              <time dateTime={marketUpdatedAt}>
                {new Intl.DateTimeFormat('en-US', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(marketUpdatedAt))}
              </time>
            </p>
          ) : null}
        </div>
        {collectorMode ? (
          <CollectorControls
            onResultsChanged={reloadCatalog}
            onOperatorConnected={setOperatorToken}
          />
        ) : legacyMode ? (
          <div className="handbook-refresh">
            <button
              type="button"
              disabled={refreshing}
              onClick={() => void refreshPrices()}
            >
              {refreshing ? 'Refreshing…' : 'Refresh Prices'}
            </button>
            <span role="status">{refreshMessage}</span>
          </div>
        ) : null}
      </section>

      {loadError ? (
        <StatusPanel tone="danger" title="Recipes unavailable">
          The recipe list could not be loaded. Try again when the service is
          available.
        </StatusPanel>
      ) : null}

      {loadError ? null : !response ? (
        <StatusPanel tone="info" title="Loading recipes" />
      ) : entries.length === 0 &&
        !filters.search.trim() &&
        filters.category === 'all' ? (
        <section className="empty-state" aria-labelledby="empty-heading">
          <h2 id="empty-heading">No crafting targets available</h2>
          <p>Crafting recipes will appear here.</p>
        </section>
      ) : (
        <>
          <section
            className="handbook-controls"
            aria-label="Crafting target search and item types"
          >
            <label className="catalog-search catalog-filter">
              <span>Item name</span>
              <input
                type="search"
                placeholder="Search items or targets…"
                value={filters.search}
                onChange={(event) => updateFilter('search', event.target.value)}
              />
            </label>
            <label className="catalog-filter">
              <span>Tag</span>
              <select
                value={filters.tag ?? 'all'}
                onChange={(e) => updateFilter('tag', e.target.value)}
              >
                <option value="all">All tags</option>
                {[...new Set(entries.flatMap((e) => e.recipe.tags))]
                  .sort()
                  .map((tag) => (
                    <option key={tag}>{tag}</option>
                  ))}
              </select>
            </label>
            <label className="catalog-filter">
              <span>Item class</span>
              <select
                value={filters.category}
                onChange={(event) =>
                  updateFilter('category', event.target.value)
                }
              >
                <option value="all">All classes</option>
                {categories.map((category) => (
                  <option key={category} value={category}>
                    {category.replaceAll('-', ' ')}
                  </option>
                ))}
              </select>
            </label>
            <div className="catalog-filter">
              <label htmlFor="minimum-profit">
                Min profit ({filters.profitCurrency === 'divine' ? 'div' : 'c'})
              </label>
              <div className="catalog-profit-filter">
                <input
                  id="minimum-profit"
                  type="number"
                  step="any"
                  placeholder="Any"
                  value={filters.minProfit ?? ''}
                  onChange={(event) =>
                    updateFilter('minProfit', event.target.value)
                  }
                />
                <select
                  aria-label="Profit currency"
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
                </select>
              </div>
            </div>
            <label className="catalog-filter">
              <span>Min ROI (%)</span>
              <input
                type="number"
                step="any"
                placeholder="Any"
                value={filters.minRoi ?? ''}
                onChange={(event) => updateFilter('minRoi', event.target.value)}
              />
            </label>
          </section>

          <div className="catalog-results">
            <span role="status">
              {filteredEntries.length} of {entries.length} recipes
            </span>
            <button
              type="button"
              onClick={() => setFilters(defaultCatalogFilters)}
            >
              Reset filters
            </button>
          </div>
          <CatalogTable
            entries={filteredEntries}
            filters={filters}
            onSort={(sort) =>
              setFilters((current) => ({
                ...current,
                sort,
                direction:
                  (current.sort ?? 'title') === sort
                    ? (current.direction ??
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
            Asking-price estimates, not completed sales. ROI = profit ÷ expected
            cost. One eligible seller can earn grade C. Currencies sorted
            separately. Methods for the same target are grouped, best valid
            profit first.
          </p>
        </>
      )}

      {collectorMode && operatorToken !== null ? (
        <HomeSettings operatorToken={operatorToken} />
      ) : null}
    </>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<CatalogRoute />} />
        <Route path="recipes" element={<RecipeLibraryPage />} />
        <Route path="recipes/pohx/:guideId" element={<PohxRecipePage />} />
        <Route path="recipes/:recipeId" element={<RecipePage />} />
        <Route path="factory" element={<FactoryPage />} />
        <Route path="market" element={<MarketTrendsPage />} />
        <Route
          path="*"
          element={<StatusPanel tone="warning" title="Page not found" />}
        />
      </Route>
    </Routes>
  );
}
