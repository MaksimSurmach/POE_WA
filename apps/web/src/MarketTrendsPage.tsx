import type {
  CatalogResponse,
  RecipeTrendResponse,
  TrendOverviewEntry,
  TrendOverviewResponse,
  TrendRange,
} from '@poe-worksmith/contracts';
import { trendRangeSchema } from '@poe-worksmith/contracts';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { createApiClient } from './apiClient.js';
import { StatusPanel } from './components.js';
import {
  PriceTrendChart,
  TrendFacts,
  describeTrend,
} from './PriceTrendChart.js';
import { RecipeMarketOverview } from './RecipeMarketOverview.js';
import './marketTrends.css';

const apiClient = createApiClient();

export const trendRanges = trendRangeSchema.options;
const rangeLabels: Record<TrendRange, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '1y': '1 year',
};

export type TrendSort = 'change' | 'ask' | 'recent' | 'title';

function byTitle(left: TrendOverviewEntry, right: TrendOverviewEntry) {
  return left.title.localeCompare(right.title);
}

/**
 * Sorts dashboard rows. Percent change is currency-neutral; latest ask is
 * compared only within one currency, grouped chaos then divine. Rows without
 * the needed evidence keep a stable title order at the end.
 */
export function sortTrendEntries(
  entries: readonly TrendOverviewEntry[],
  sort: TrendSort,
): TrendOverviewEntry[] {
  const rows = [...entries];
  if (sort === 'title') return rows.sort(byTitle);
  return rows.sort((left, right) => {
    const a = left.summary;
    const b = right.summary;
    if (sort === 'change') {
      const x = a?.change?.percent ?? null;
      const y = b?.change?.percent ?? null;
      if (x === null || y === null)
        return x === y ? byTitle(left, right) : x === null ? 1 : -1;
      return y - x || byTitle(left, right);
    }
    if (!a || !b) return a === b ? byTitle(left, right) : a ? -1 : 1;
    if (sort === 'recent')
      return (
        Date.parse(b.latestObservedAt) - Date.parse(a.latestObservedAt) ||
        byTitle(left, right)
      );
    if (a.currency !== b.currency) return a.currency.localeCompare(b.currency);
    return b.latestAsk - a.latestAsk || byTitle(left, right);
  });
}

export function filterTrendEntries(
  entries: readonly TrendOverviewEntry[],
  search: string,
) {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return [...entries];
  return entries.filter((entry) =>
    `${entry.title} ${entry.recipeId} ${entry.category}`
      .toLocaleLowerCase()
      .includes(query),
  );
}

function parseRange(value: string | null): TrendRange {
  return trendRanges.includes(value as TrendRange)
    ? (value as TrendRange)
    : '7d';
}

export function RangeControls({
  range,
  onChange,
}: {
  range: TrendRange;
  onChange(range: TrendRange): void;
}) {
  return (
    <div
      aria-label="History range"
      className="category-filters trend-ranges"
      role="group"
    >
      {trendRanges.map((value) => (
        <button
          aria-label={rangeLabels[value]}
          aria-pressed={range === value}
          key={value}
          onClick={() => onChange(value)}
          type="button"
        >
          {value}
        </button>
      ))}
    </div>
  );
}

/** Fetches and renders one recipe's history; reused on the recipe page. */
export function RecipeTrendPanel({
  recipeId,
  range,
  onRangeChange,
  expectedLeagueId,
  onReload,
}: {
  recipeId: string;
  range: TrendRange;
  expectedLeagueId?: string;
  onReload?: () => void;
  /** Shows range buttons when the panel owns its range (recipe page). */
  onRangeChange?: (range: TrendRange) => void;
}) {
  const [response, setResponse] = useState<RecipeTrendResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setResponse(null);
    setFailed(false);
    apiClient
      .getRecipeTrend(
        recipeId,
        range,
        AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      )
      .then((value) => {
        if (!controller.signal.aborted) setResponse(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [recipeId, range, expectedLeagueId]);
  const trend =
    response?.data.recipeId === recipeId && response.data.range === range
      ? response.data
      : undefined;
  return (
    <div className="trend-panel" aria-busy={!trend && !failed}>
      {onRangeChange ? (
        <RangeControls range={range} onChange={onRangeChange} />
      ) : null}
      {trend && expectedLeagueId && trend.league?.id !== expectedLeagueId ? (
        <StatusPanel
          tone="warning"
          title="League changed while loading history"
        >
          <button type="button" onClick={onReload}>
            Reload current market
          </button>
        </StatusPanel>
      ) : failed ? (
        <StatusPanel tone="danger" title="Price history unavailable" />
      ) : !trend ? (
        <StatusPanel tone="info" title="Loading price history" />
      ) : (
        <>
          <PriceTrendChart trend={trend} />
          <TrendFacts summary={trend.summary} />
          {trend.summary && trend.buckets.length > 0 ? (
            <p className="trend-panel__summary">{describeTrend(trend)}</p>
          ) : null}
          <p className="trend-panel__note">
            Cheapest comparable asking prices from saved observations, not
            confirmed sales. Converted prices also move with exchange rates.
            Traded volume is unknown.
          </p>
        </>
      )}
    </div>
  );
}

export function MarketTrendsPage() {
  const [params, setParams] = useSearchParams();
  const range = parseRange(params.get('range'));
  const [response, setResponse] = useState<TrendOverviewResponse | null>(null);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<TrendSort>('change');
  const reload = () => setRevision((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    setResponse(null);
    setCatalog(null);
    setCatalogFailed(false);
    setFailed(false);
    apiClient
      .getTrendOverview(
        range,
        AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      )
      .then((value) => {
        if (!controller.signal.aborted) setResponse(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    apiClient
      .getCatalog(
        AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      )
      .then((value) => {
        if (!controller.signal.aborted) setCatalog(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setCatalogFailed(true);
      });
    return () => controller.abort();
  }, [range, revision]);

  const loadedOverview =
    response?.data.range === range ? response.data : undefined;
  const league = catalog?.data?.league;
  const leagueMismatch = Boolean(
    catalog?.data && loadedOverview && league?.id !== loadedOverview.league?.id,
  );
  const overview =
    league && loadedOverview?.league?.id === league.id
      ? loadedOverview
      : undefined;
  const rows = useMemo(
    () =>
      sortTrendEntries(
        filterTrendEntries(overview?.entries ?? [], search),
        sort,
      ),
    [overview, search, sort],
  );
  const selectedId = params.get('recipe');
  const update = (next: { range?: TrendRange; recipe?: string }) => {
    const value = new URLSearchParams(params);
    if (next.range) value.set('range', next.range);
    if (next.recipe) value.set('recipe', next.recipe);
    setParams(value, { replace: true });
  };

  return (
    <section className="market-trends" aria-labelledby="market-trends-heading">
      <header className="catalog-heading">
        <div>
          <h1 id="market-trends-heading">Market trends</h1>
          <p>
            Compare asking prices and how quickly listings leave Trade search.
          </p>
        </div>
        <div className="trade-dashboard__league">
          <small>PATH OF EXILE 1</small>
          {league ? `${league.name} · PC` : 'League unresolved · PC'}
        </div>
      </header>

      <RecipeMarketOverview
        response={catalog}
        failed={catalogFailed}
        onRetry={reload}
        selectedId={selectedId}
        trends={overview}
        onSelect={(recipe) => update({ recipe })}
      />
      <h2 id="recipe-price-history" className="recipe-trends-heading">
        Recipe price history
      </h2>
      <RangeControls
        range={range}
        onChange={(value) => update({ range: value })}
      />

      <section
        aria-label="Market trend controls"
        className="handbook-controls trend-controls"
      >
        <label className="catalog-search">
          <span className="visually-hidden">Search recipes</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search recipes…"
            type="search"
            value={search}
          />
        </label>
        <label>
          Sort{' '}
          <select
            onChange={(event) => setSort(event.target.value as TrendSort)}
            value={sort}
          >
            <option value="change">Price change</option>
            <option value="ask">Latest ask (per currency)</option>
            <option value="recent">Last observed</option>
            <option value="title">Recipe</option>
          </select>
        </label>
        <label className="market-trends__picker">
          <span>Recipe</span>
          <select
            aria-label="Choose recipe"
            disabled={!rows.length}
            value={selectedId ?? ''}
            onChange={(event) => update({ recipe: event.target.value })}
          >
            <option disabled value="">
              Select a recipe
            </option>
            {selectedId &&
            !rows.some((entry) => entry.recipeId === selectedId) ? (
              <option value={selectedId}>
                {overview?.entries.find(
                  (entry) => entry.recipeId === selectedId,
                )?.title ?? selectedId}
              </option>
            ) : null}
            {rows.map((entry) => (
              <option key={entry.recipeId} value={entry.recipeId}>
                {entry.title}
              </option>
            ))}
          </select>
          {search && !rows.length ? (
            <small role="status">No recipes match this search.</small>
          ) : null}
        </label>
      </section>

      {leagueMismatch ? (
        <StatusPanel tone="warning" title="League changed while loading">
          <button type="button" onClick={reload}>
            Reload current market
          </button>
        </StatusPanel>
      ) : failed ? (
        <StatusPanel tone="danger" title="Market trends unavailable">
          Price history could not be loaded. Try again when the service is
          available.
        </StatusPanel>
      ) : !overview ? (
        <StatusPanel tone="info" title="Loading market trends" />
      ) : overview.state === 'unavailable' ? (
        <StatusPanel tone="warning" title="League unresolved">
          Price history appears once the current league is known.
        </StatusPanel>
      ) : (
        <>
          {overview.state === 'empty' ? (
            <p className="handbook-empty">
              No price history yet. Observations are saved when prices refresh.
            </p>
          ) : null}
          <div className="market-trends__history">
            <section
              aria-label="Selected recipe price history"
              className="market-trends__detail detail-section"
            >
              {selectedId ? (
                <>
                  <h2>
                    {overview.entries.find((e) => e.recipeId === selectedId)
                      ?.title ?? selectedId}
                  </h2>
                  <Link
                    className="recipe-link"
                    to={`/recipes/${encodeURIComponent(selectedId)}`}
                  >
                    Open recipe ›
                  </Link>
                  <RecipeTrendPanel
                    range={range}
                    recipeId={selectedId}
                    expectedLeagueId={league!.id}
                    onReload={reload}
                  />
                </>
              ) : (
                <p>Select a recipe to see its price history.</p>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}
