import type {
  CatalogEntry,
  CatalogResponse,
  MarketStarterTarget,
} from '@poe-worksmith/contracts';
import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, Route, Routes } from 'react-router-dom';

import {
  defaultCatalogFilters,
  filterMarketTargets,
  formatMarginPercent,
  filterCatalog,
  getPriceStatus,
  lowestAskInCurrency,
  marketTargetItemType,
  marketTargetTitle,
  type CatalogFilters,
} from './catalog.js';
import { Money, StatusPanel } from './components.js';
import { createApiClient } from './apiClient.js';
import { RecipePage } from './RecipePage.js';
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
    MarketStarterTarget[] | null
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
              className="craft-target-list"
              aria-label="Crafting targets"
            >
              {filteredEntries.map((entry) => (
                <RecipeTargetRow entry={entry} key={entry.recipe.id} />
              ))}
              {filteredTargets.map((target) => (
                <MarketTargetRow
                  key={`${target.name}:${target.slot}:${target.baseTypes.join('|')}`}
                  target={target}
                />
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
  const lowestAsk = lowestAskInCurrency(
    snapshot,
    entry.evaluation.estimatedSalePrice?.currency ??
      entry.evaluation.expectedCraftCost?.currency ??
      null,
  );
  const ask = lowestAsk?.price ?? entry.evaluation.estimatedSalePrice;
  const itemType = entry.recipe.category.replaceAll('-', ' ');
  return (
    <article className="craft-target-card">
      <div className="craft-target-card__identity">
        <ItemArtwork
          key={entry.itemPreview?.iconUrl ?? itemType}
          iconUrl={entry.itemPreview?.iconUrl ?? null}
          itemType={itemType}
        />
        <div className="craft-target-card__copy">
          <Link to={`/recipes/${entry.recipe.id}`} title={entry.recipe.title}>
            <strong>{entry.recipe.title}</strong>
          </Link>
          <div className="craft-target-card__details">
            <span>{itemType}</span>
            <span>{entry.recipe.craftMethod}</span>
          </div>
        </div>
      </div>
      <div className="craft-target-card__market">
        <div className="craft-target-card__metrics">
          <div>
            <small>Craft cost</small>
            <Money price={entry.evaluation.expectedCraftCost} />
          </div>
          <div>
            <small>
              {lowestAsk ? 'Lowest ask' : 'Market estimate'}
              {(entry.evaluation.estimatedSalePrice?.currency ??
              entry.evaluation.expectedCraftCost?.currency)
                ? ` (${entry.evaluation.estimatedSalePrice?.currency ?? entry.evaluation.expectedCraftCost?.currency})`
                : ''}
            </small>
            {ask ? <Money price={ask} /> : <strong>—</strong>}
          </div>
          <div>
            <small>Listed</small>
            <strong>{snapshot ? snapshot.totalResults : '—'}</strong>
          </div>
        </div>
        <small className="craft-target-card__snapshot">
          {snapshot ? (
            <>
              Trade snapshot ·{' '}
              <time dateTime={snapshot.capturedAt}>
                {successfulAtFormatter.format(new Date(snapshot.capturedAt))}
              </time>
            </>
          ) : entry.evaluation.lastSuccessfulAt ? (
            <>
              Last successful ·{' '}
              <time dateTime={entry.evaluation.lastSuccessfulAt}>
                {successfulAtFormatter.format(
                  new Date(entry.evaluation.lastSuccessfulAt),
                )}
              </time>
            </>
          ) : (
            'No snapshot'
          )}
          {entry.evaluation.marginPercent === null
            ? ''
            : ` · ROI ${formatMarginPercent(entry.evaluation.marginPercent)}`}
          {` · ${getPriceStatus(entry.evaluation.status)}`}
        </small>
      </div>
    </article>
  );
}

function MarketTargetRow({ target }: { target: MarketStarterTarget }) {
  const source = target.sources[0];
  const snapshot = target.marketSnapshot;
  const itemType = marketTargetItemType(target.slot).replaceAll('-', ' ');
  return (
    <article className="craft-target-card">
      <div className="craft-target-card__identity">
        <ItemArtwork
          key={snapshot?.iconUrl ?? target.artworkUrl ?? itemType}
          iconUrl={snapshot?.iconUrl ?? target.artworkUrl}
          itemType={itemType}
        />
        <div className="craft-target-card__copy">
          <strong title={marketTargetTitle(target)}>
            {marketTargetTitle(target)}
          </strong>
          <div className="craft-target-card__details">
            <span>{target.builds[0]}</span>
            <span>{itemType}</span>
            <span>
              {target.league} · {target.patch}
            </span>
          </div>
          <div className="craft-target-card__links">
            {target.tradeUrl ? (
              <a href={target.tradeUrl} rel="noreferrer" target="_blank">
                Trade database
              </a>
            ) : null}
            {source ? (
              <a href={source.url} rel="noreferrer" target="_blank">
                {source.title}
              </a>
            ) : null}
          </div>
        </div>
      </div>
      <div className="craft-target-card__market">
        <div className="craft-target-card__metrics">
          <div>
            <small>Stash estimate</small>
            {snapshot && snapshot.price.amount !== null ? (
              <Money
                price={{
                  amount: snapshot.price.amount,
                  currency: snapshot.price.currency,
                }}
              />
            ) : (
              <strong>—</strong>
            )}
          </div>
          <div>
            <small>
              {snapshot && snapshot.variantCount > 1
                ? 'Variant listings'
                : 'Listed'}
            </small>
            <strong>{snapshot?.listingCount ?? '—'}</strong>
          </div>
        </div>
        <small className="craft-target-card__snapshot">
          {snapshot ? (
            <>
              {snapshot.league} · {snapshot.variantCount}{' '}
              {snapshot.variantCount === 1 ? 'base variant' : 'base variants'} ·{' '}
              <time dateTime={snapshot.capturedAt}>
                {successfulAtFormatter.format(new Date(snapshot.capturedAt))}
              </time>{' '}
              ·{' '}
              <a
                href={`https://poe.ninja/poe1/economy/${encodeURIComponent(snapshot.league.toLowerCase())}/base-types`}
                rel="noreferrer"
                target="_blank"
              >
                poe.ninja
              </a>
            </>
          ) : (
            'No BaseType snapshot'
          )}
        </small>
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
        <Route path="catalog" element={<CatalogRoute />} />
        <Route path="recipes/:recipeId" element={<RecipePage />} />
      </Route>
    </Routes>
  );
}
