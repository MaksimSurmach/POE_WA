import type {
  CatalogEntry,
  CatalogResponse,
  CurrentLeagueResponse,
} from '@poe-worksmith/contracts';
import { useEffect, useMemo, useState, useRef } from 'react';
import { Link, Outlet, Route, Routes } from 'react-router-dom';

import {
  defaultCatalogFilters,
  formatMarginPercent,
  filterCatalog,
  type CatalogFilters,
} from './catalog.js';
import { Money, ProfitBadge, StatusPanel } from './components.js';
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
  const [league, setLeague] = useState<CurrentLeagueResponse['data'] | null>(
    null,
  );
  const refreshBaseline = useRef<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState('');
  useEffect(() => {
    apiClient
      .getCurrentLeague()
      .then((r) => setLeague(r.data))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!refreshing) return;
    let active = true;
    const poll = setInterval(() => {
      apiClient
        .getRefreshFreshness()
        .then(async (r) => {
          if (!active) return;
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
  }, [refreshing]);
  async function refreshPrices() {
    setRefreshing(true);
    setRefreshMessage('Requesting price refresh…');
    try {
      refreshBaseline.current =
        (await apiClient.getRefreshFreshness()).data.lastAttempt?.id ?? null;
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
    .map(({ snapshot }) => snapshot?.capturedAt)
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
      </section>

      {loadError ? (
        <StatusPanel tone="danger" title="Recipes unavailable">
          The recipe list could not be loaded. Try again when the service is
          available.
        </StatusPanel>
      ) : null}

      {!response && !loadError ? (
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
            <label className="catalog-search">
              <span className="visually-hidden">Search items</span>
              <input
                type="search"
                placeholder="Search items or targets…"
                value={filters.search}
                onChange={(event) => updateFilter('search', event.target.value)}
              />
            </label>
            <label>
              Tag{' '}
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
            <label>
              Sort{' '}
              <select
                value={filters.sort ?? 'title'}
                onChange={(e) =>
                  updateFilter('sort', e.target.value as CatalogFilters['sort'])
                }
              >
                <option value="title">Target</option>
                <option value="cost">Expected cost</option>
                <option value="profit">Profit</option>
                <option value="roi">ROI</option>
                <option value="freshness">Freshness</option>
              </select>
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
            <p className="handbook-empty">No items match these filters.</p>
          ) : (
            <section
              className="craft-target-list"
              aria-label="Crafting targets"
            >
              {filteredEntries.map((entry) => (
                <RecipeTargetRow entry={entry} key={entry.recipe.id} />
              ))}
            </section>
          )}
        </>
      )}
    </>
  );
}

function RecipeTargetRow({ entry }: { entry: CatalogEntry }) {
  const snapshot = entry.snapshot;
  const ask = entry.evaluation.estimatedSalePrice;
  const itemType = entry.recipe.category.replaceAll('-', ' ');
  const method = entry.recipe.craftMethod.replaceAll('-', ' ');
  return (
    <article className="craft-target-card">
      <div className="craft-target-card__identity">
        {entry.itemPreview ? (
          <ItemTooltip item={entry.itemPreview} />
        ) : (
          <ItemArtwork iconUrl={null} itemType={itemType} />
        )}
        <div className="craft-target-card__copy">
          <Link to={`/recipes/${entry.recipe.id}`} title={entry.recipe.title}>
            <strong>{entry.recipe.title}</strong>
          </Link>
          <div className="craft-target-card__details">
            <span>{itemType}</span>
            <span>{method}</span>
            <span>Patch {entry.recipe.patch ?? 'unverified'}</span>
          </div>
          {entry.evaluation.status === 'stale' &&
          entry.evaluation.lastSuccessfulAt ? (
            <small className="craft-target-card__freshness">
              Older prices ·{' '}
              <time dateTime={entry.evaluation.lastSuccessfulAt}>
                {new Intl.DateTimeFormat('en-US', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(entry.evaluation.lastSuccessfulAt))}
              </time>
            </small>
          ) : null}
        </div>
      </div>
      <div className="craft-target-card__market">
        <div className="craft-target-card__metrics">
          <div>
            <small>Expected cost</small>
            <Money price={entry.evaluation.expectedCraftCost} />
          </div>
          <div>
            <small>Cheapest confirmed ask</small>
            {ask ? <Money price={ask} /> : <strong>—</strong>}
          </div>
          <div>
            <small>Profit</small>
            {entry.evaluation.profit ? (
              <ProfitBadge {...entry.evaluation.profit} />
            ) : (
              <strong>—</strong>
            )}
          </div>
          <div>
            <small>ROI</small>
            <strong>
              {entry.evaluation.marginPercent === null
                ? '—'
                : formatMarginPercent(entry.evaluation.marginPercent)}
            </strong>
          </div>
          <div>
            <small>Verified sellers</small>
            <strong>{snapshot ? snapshot.listings.length : '—'}</strong>
          </div>
          <div>
            <small>Market confidence</small>
            <strong>{entry.evaluation.confidence ?? 'Unknown'}</strong>
          </div>
        </div>
        {snapshot ? (
          <small>
            {snapshot.coverage ?? 'Unknown'} coverage ·{' '}
            {new Date(snapshot.capturedAt).toLocaleString('en-US')}
            {snapshot.expiresAt && Date.parse(snapshot.expiresAt) < Date.now()
              ? ' · Stale'
              : ''}
          </small>
        ) : null}
      </div>
    </article>
  );
}

function ItemArtwork({
  iconUrl,
  itemType,
}: {
  iconUrl: string | null;
  itemType: string;
}) {
  const [failed, setFailed] = useState(false);
  return iconUrl && !failed ? (
    <img
      alt=""
      className="craft-target-card__art"
      loading="lazy"
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
      src={iconUrl}
    />
  ) : (
    <span
      aria-hidden="true"
      className="craft-target-card__art craft-target-card__art--fallback"
    >
      {itemType.slice(0, 1).toLocaleUpperCase()}
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
