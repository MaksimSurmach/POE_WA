import type {
  CatalogResponse,
  CraftingPrices,
  TrendOverview,
} from '@poe-worksmith/contracts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  useLocation,
  useNavigate,
  useOutletContext,
  useSearchParams,
} from 'react-router-dom';
import {
  ArrowDownTrayIcon,
  PlusIcon,
  StarIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { createApiClient } from './apiClient.js';
import { StatusPanel } from './components.js';
import { formatTimestamp } from './dateTime.js';
import { Button, Input, NativeSelect } from './ui.js';
import { useFavorites } from './Watchlist.js';
import {
  favoriteTargetIds,
  itemClassLabel,
  selectRecipeLibrary,
  type RecipeLibraryOutput,
} from './recipeLibraryModel.js';
import {
  LibraryMoney,
  TargetArt,
  TargetDetailDialog,
} from './TargetDetailDialog.js';
import {
  compositionGroups,
  enrichMarketOutputs,
  marketMethodLabel,
  marketRowsCsv,
  type MarketColor,
  type MarketGroup,
  type MarketRow,
  type MarketSize,
} from './marketHomeModel.js';
import './marketHome.css';

const api = createApiClient();
const defaultColumns = [
  'method',
  'ask',
  'change',
  'listings',
  'cost',
  'margin',
];
const columnLabels: Record<string, string> = {
  method: 'Craft method',
  ask: 'Lowest ask',
  change: 'Change',
  listings: 'Listings',
  cost: 'Craft cost',
  margin: 'Est. craft margin',
  sellers: 'Sellers',
  exits: 'Exits · 24h',
  seen: 'Seen · 24h',
  repriced: 'Repriced · 24h',
  modifiers: 'Required modifiers',
  history: 'Price history',
  methods: 'Methods',
};
const groupOptions = [
  ['item-class', 'Item class'],
  ['craft-method', 'Craft method'],
  ['price-range', 'Price range'],
  ['listing-activity', 'Listing activity'],
] as const;
const colorOptions = [
  ['price-change', 'Price change'],
  ['cost-spread', 'Ask − craft cost'],
  ['listing-activity', 'Listing activity'],
] as const;
const sizeOptions = [
  ['captured-listings', 'Captured listings'],
  ['equal', 'Equal tiles'],
  ['asking-price', 'Asking price'],
] as const;
const number = (value: number | null | undefined) =>
  value == null
    ? '—'
    : new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(
        value,
      );
function tone(value: number | null) {
  return value === null
    ? 'unknown'
    : value > 0
      ? 'positive'
      : value < 0
        ? 'negative'
        : 'neutral';
}
function tileColor(value: number | null, color: MarketColor) {
  if (value === null) return '#eef1f4';
  if (value === 0) return '#d8e0e8';
  if (color === 'listing-activity')
    return `hsl(216 67% ${Math.max(38, 92 - Math.log1p(value) * 11)}%)`;
  return value > 0 ? '#d5eee3' : '#f8dce0';
}
function observedSpan(from: string, to: string) {
  const minutes = Math.max(
    0,
    Math.round((Date.parse(to) - Date.parse(from)) / 60000),
  );
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60),
    rest = minutes % 60;
  return `${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${!days && (!hours || rest) ? `${rest}m ` : ''}observed`;
}
export function MarketHome() {
  const [params, setParams] = useSearchParams();
  const pendingParams = useRef(params);
  useLayoutEffect(() => {
    pendingParams.current = params;
  }, [params]);
  function commitParams(
    next: URLSearchParams,
    options?: { replace?: boolean; state?: unknown },
  ) {
    pendingParams.current = next;
    setParams(next, options);
  }
  const location = useLocation();
  const navigate = useNavigate();
  const publish = useOutletContext<
    ((data: NonNullable<CatalogResponse['data']>) => void) | undefined
  >();
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [trends, setTrends] = useState<TrendOverview | null>(null);
  const [error, setError] = useState(false);
  const [trendError, setTrendError] = useState(false);
  const [revision, setRevision] = useState(0);
  const favorites = useFavorites();
  const searchRef = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const oldScroll = useRef(0);
  const closing = useRef(false);
  const [columns, setColumns] = useState(defaultColumns);
  const visibleColumns = Object.keys(columnLabels).filter((key) =>
    columns.includes(key),
  );
  const [density, setDensity] = useState(() => {
    try {
      return localStorage.getItem('worksmith:density') === 'compact'
        ? 'compact'
        : 'comfortable';
    } catch {
      return 'comfortable';
    }
  });
  const [materials, setMaterials] = useState<CraftingPrices | null>(null);
  const [materialsError, setMaterialsError] = useState(false);
  const entries = catalog?.data?.entries ?? [];
  const search = params.get('search') ?? '';
  const family = params.get('family') ?? 'all';
  const category = params.get('category') ?? 'all';
  const currency =
    (params.get('currency') ?? params.get('profitCurrency')) === 'divine'
      ? 'divine'
      : 'chaos';
  const group = (
    groupOptions.some(([id]) => id === params.get('group'))
      ? params.get('group')
      : 'item-class'
  ) as MarketGroup;
  const color = (
    colorOptions.some(([id]) => id === params.get('color'))
      ? params.get('color')
      : 'price-change'
  ) as MarketColor;
  const size = (
    sizeOptions.some(([id]) => id === params.get('size'))
      ? params.get('size')
      : 'captured-listings'
  ) as MarketSize;
  const selected = params.get('target');
  const materialView = params.get('section') === 'materials';
  const modifier = params.get('modifier') ?? '';
  const selection = selectRecipeLibrary(entries, {
    family,
    category,
    currency,
    estimatesOnly: params.get('estimated') === '1',
    favoritesOnly: params.get('favorites') === '1',
    favoriteIds: favorites.ids,
  });
  const availableModifiers = [
    ...new Map(
      entries
        .flatMap((e) => e.itemPreview?.modifiers ?? [])
        .map((m) => [`${m.generationType}:${m.canonicalId}`, m]),
    ).entries(),
  ].sort((a, b) => a[1].label.localeCompare(b[1].label));
  const scopedOutputs = selection.outputs.filter(
    (o) =>
      (!modifier ||
        o.entry.itemPreview?.modifiers.some(
          (m) => `${m.generationType}:${m.canonicalId}` === modifier,
        )) &&
      (!search.trim() ||
        [
          o.name,
          o.entry.recipe.baseName,
          ...(o.entry.itemPreview?.modifiers.map((m) => m.label) ?? []),
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase())),
  );
  const currentTrends =
    trends?.league?.id === catalog?.data?.league?.id ? trends : null;
  const rows = enrichMarketOutputs(scopedOutputs, currentTrends?.entries ?? []);
  const sort = params.get('sort') ?? 'item';
  const direction = params.get('direction') === 'desc' ? -1 : 1;
  const sortValue = (row: MarketRow): number | string | null => {
    switch (sort) {
      case 'ask':
        return row.output.ask?.amount ?? null;
      case 'cost':
        return row.output.cost?.amount ?? null;
      case 'margin':
        return row.spread?.amount ?? null;
      case 'change':
        return row.change?.percent ?? null;
      case 'listings':
        return row.captured;
      case 'sellers':
        return row.sellers;
      case 'exits':
        return row.exits;
      case 'seen':
        return row.output.quoteEvidence?.seen ?? null;
      case 'repriced':
        return row.output.quoteEvidence?.repriced ?? null;
      case 'methods':
        return row.output.methods.length;
      case 'history':
        return row.summary?.latestObservedAt ?? null;
      case 'modifiers':
        return (
          row.output.entry.itemPreview?.modifiers
            .map((m) => m.label)
            .join('; ') ?? null
        );
      case 'method':
        return marketMethodLabel(row.output);
      default:
        return row.output.name;
    }
  };
  rows.sort((a, b) => {
    const x = sortValue(a),
      y = sortValue(b);
    if (x === null || y === null)
      return x === y
        ? a.output.name.localeCompare(b.output.name)
        : x === null
          ? 1
          : -1;
    return (
      (typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x).localeCompare(String(y))) * direction ||
      a.output.name.localeCompare(b.output.name)
    );
  });
  const composition = compositionGroups(rows, group, color, size);
  const detail = selected
    ? selectRecipeLibrary(
        entries.filter((e) => e.recipe.targetSignature === selected),
        { family, currency },
      ).outputs[0]
    : undefined;
  const favoriteIds = favoriteTargetIds(favorites.ids, entries);
  const updated = rows
    .map((row) => row.output.quoteAt)
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1);
  function update(key: string, value: string) {
    const next = new URLSearchParams(pendingParams.current);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
    commitParams(next, { replace: true });
  }
  function clearFilters() {
    const next = new URLSearchParams(pendingParams.current);
    for (const key of [
      'search',
      'family',
      'category',
      'modifier',
      'estimated',
      'favorites',
    ])
      next.delete(key);
    commitParams(next, { replace: true });
  }
  useEffect(() => {
    const stop = new AbortController();
    let inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]);
      await Promise.allSettled([
        api
          .getCatalog(signal)
          .then((value) => {
            if (stop.signal.aborted) return;
            if (value.data) {
              setCatalog(value);
              publish?.(value.data);
              setError(false);
            } else setError(true);
          })
          .catch(() => {
            if (!stop.signal.aborted) setError(true);
          }),
        api
          .getTrendOverview('7d', signal)
          .then((value) => {
            if (!stop.signal.aborted) {
              setTrends(value.data);
              setTrendError(false);
            }
          })
          .catch(() => {
            if (!stop.signal.aborted) setTrendError(true);
          }),
      ]);
      inFlight = false;
    }
    void load();
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('focus', refresh);
    const timer = setInterval(refresh, 60000);
    return () => {
      stop.abort();
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [revision, publish]);
  useEffect(() => {
    if (!materialView) return;
    let active = true;
    setMaterialsError(false);
    void api
      .getCraftingPrices()
      .then((r) => {
        if (active) setMaterials(r.data);
      })
      .catch(() => {
        if (active) setMaterialsError(true);
      });
    return () => {
      active = false;
    };
  }, [materialView, revision]);
  function open(
    output: RecipeLibraryOutput,
    tab: 'market' | 'recipe',
    element: HTMLElement,
    recipeId = output.selectedRecipeId,
  ) {
    opener.current = element;
    oldScroll.current = window.scrollY;
    const next = new URLSearchParams(pendingParams.current);
    next.set('target', output.id);
    next.set('recipe', recipeId);
    next.set('detail', tab);
    commitParams(next, { state: { marketDialog: true } });
  }
  function close() {
    if (closing.current) return;
    closing.current = true;
    if (location.state?.marketDialog) void navigate(-1);
    else {
      const next = new URLSearchParams(pendingParams.current);
      for (const key of ['target', 'recipe', 'detail']) next.delete(key);
      commitParams(next, { replace: true });
    }
  }
  useEffect(() => {
    closing.current = false;
    if (selected || !opener.current) return;
    if (opener.current.isConnected) {
      opener.current.focus({ preventScroll: true });
      window.scrollTo(0, oldScroll.current);
    } else searchRef.current?.focus();
    opener.current = null;
  }, [selected]);
  useEffect(() => {
    function shortcut(e: KeyboardEvent) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || selected)
        return;
      const el = e.target;
      if (
        el instanceof HTMLElement &&
        (el.isContentEditable || el.closest('input,textarea,select'))
      )
        return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [selected]);
  function sortBy(key: string) {
    const next = new URLSearchParams(pendingParams.current);
    next.set('sort', key);
    next.set('direction', sort === key && direction === 1 ? 'desc' : 'asc');
    commitParams(next, { replace: true });
  }
  function exportCsv() {
    const href = URL.createObjectURL(
      new Blob(['\uFEFF', marketRowsCsv(rows)], {
        type: 'text/csv;charset=utf-8',
      }),
    );
    const a = document.createElement('a');
    a.href = href;
    a.download = 'worksmith-market.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
  function changeDensity(value: string) {
    setDensity(value);
    try {
      localStorage.setItem('worksmith:density', value);
      window.dispatchEvent(new Event('worksmith-density-change'));
    } catch {
      /* This view still updates when browser storage is unavailable. */
    }
  }
  const chips = [
    ['search', search ? `Search: ${search}` : ''],
    [
      'family',
      family !== 'all'
        ? (selection.families.find((f) => f.id === family)?.label ??
          (family === 'none' ? 'No recipe' : family))
        : '',
    ],
    ['category', category !== 'all' ? itemClassLabel(category) : ''],
    [
      'modifier',
      modifier
        ? (availableModifiers.find(([id]) => id === modifier)?.[1].label ??
          'Required modifier')
        : '',
    ],
    ['estimated', params.get('estimated') === '1' ? 'With cost estimate' : ''],
    ['favorites', params.get('favorites') === '1' ? 'Favorites' : ''],
  ].filter(([, label]) => label);
  function metric(row: MarketRow, key: string) {
    switch (key) {
      case 'method':
        return (
          <button
            className="market-method-action"
            onClick={(e) => open(row.output, 'recipe', e.currentTarget)}
          >
            {marketMethodLabel(row.output)}
          </button>
        );
      case 'ask':
        return <LibraryMoney price={row.output.ask} />;
      case 'change':
        return (
          <span
            className={`market-value-${tone(row.change?.percent ?? null)}`}
            title={
              row.change
                ? `${formatTimestamp(row.change.fromObservedAt)} → ${formatTimestamp(row.change.toObservedAt)}`
                : 'No comparable observed change'
            }
          >
            {row.change?.percent == null
              ? '—'
              : `${row.change.percent > 0 ? '+' : ''}${number(row.change.percent)}%`}
            <small>
              {row.change
                ? observedSpan(
                    row.change.fromObservedAt,
                    row.change.toObservedAt,
                  )
                : 'Not observed'}
            </small>
          </span>
        );
      case 'listings':
        return (
          <span
            title={`Reported: ${number(row.output.quoteEvidence?.reported)}`}
          >
            {number(row.captured)}
            <small>captured</small>
          </span>
        );
      case 'cost':
        return (
          <span>
            <LibraryMoney price={row.output.cost} />
            <small>
              {row.output.cost
                ? `${row.output.coverage.estimated}/${row.output.coverage.total} routes estimated`
                : 'Not estimated'}
            </small>
          </span>
        );
      case 'margin':
        return (
          <span className={`market-value-${tone(row.spread?.amount ?? null)}`}>
            <LibraryMoney price={row.spread} />
            <small>{row.spread ? 'Provisional' : 'Not estimated'}</small>
          </span>
        );
      case 'sellers':
        return number(row.sellers);
      case 'exits':
        return number(row.exits);
      case 'seen':
        return number(row.output.quoteEvidence?.seen);
      case 'repriced':
        return number(row.output.quoteEvidence?.repriced);
      case 'modifiers':
        return (
          row.output.entry.itemPreview?.modifiers
            .map((m) => m.label)
            .join('; ') || '—'
        );
      case 'history':
        return (
          <button
            className="market-method-action"
            onClick={(e) => open(row.output, 'market', e.currentTarget)}
          >
            View history
          </button>
        );
      case 'methods':
        return row.output.methods.length;
      default:
        return '—';
    }
  }
  return (
    <section
      className={`market-home market-density-${density}`}
      aria-labelledby="market-home-title"
    >
      <header className="market-home-heading">
        <div>
          <h1 id="market-home-title">Market overview</h1>
          <p>
            Follow the item you want. Explore its market and ways to craft it.
          </p>
          {updated ? (
            <small>
              {catalog?.isStale ? 'Stale snapshot' : 'Market snapshot'} ·{' '}
              <time dateTime={updated}>{formatTimestamp(updated)}</time>
            </small>
          ) : (
            <small>Snapshot time unavailable</small>
          )}
        </div>
        <span className="market-track-action">
          <Button disabled aria-describedby="track-unavailable">
            <PlusIcon />
            Track item
          </Button>
          <small id="track-unavailable">
            Independent monitoring unavailable
          </small>
        </span>
      </header>
      {error ? (
        <StatusPanel tone="danger" title="Market could not be refreshed">
          {catalog?.data ? 'Showing the last loaded snapshot. ' : ''}
          <Button onClick={() => setRevision((n) => n + 1)}>Retry</Button>
        </StatusPanel>
      ) : null}
      {!catalog && !error ? (
        <StatusPanel tone="info" title="Loading market" />
      ) : null}
      <section
        className="market-composition"
        data-color={color}
        aria-labelledby="composition-title"
      >
        <header>
          <div>
            <h2 id="composition-title">Market composition</h2>
            <p>
              {catalog
                ? `One tile per exact target · ${rows.length} targets`
                : 'Loading targets…'}
            </p>
          </div>
          <div className="market-map-controls">
            <label>
              Group by
              <NativeSelect
                aria-label="Group by"
                value={group}
                onChange={(e) => {
                  const next = new URLSearchParams(pendingParams.current);
                  next.set('group', e.target.value);
                  if (e.target.value === 'craft-method')
                    next.set('color', 'cost-spread');
                  commitParams(next, { replace: true });
                }}
              >
                {groupOptions.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label>
              Color
              <NativeSelect
                aria-label="Color"
                value={color}
                onChange={(e) => update('color', e.target.value)}
              >
                {colorOptions.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label>
              Size
              <NativeSelect
                aria-label="Size"
                value={size}
                onChange={(e) => update('size', e.target.value)}
              >
                {sizeOptions.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </label>
          </div>
        </header>
        {trendError ? (
          <p className="market-data-note" role="status">
            Price change is unavailable. Current quotes remain visible.{' '}
            <button onClick={() => setRevision((n) => n + 1)}>Retry</button>
          </p>
        ) : null}
        <div className="market-map" aria-label="Target market composition">
          {composition.groups.map((g) => (
            <section
              key={g.id}
              className="market-map-group"
              style={{
                left: `${g.x * 100}%`,
                top: `${g.y * 100}%`,
                width: `${g.width * 100}%`,
                height: `${g.height * 100}%`,
              }}
              aria-label={g.label}
            >
              <h3 title={g.label}>{g.label}</h3>
              <div className="market-map-tiles">
                {g.tiles.map((t) => (
                  <button
                    key={t.row.output.id}
                    className={`market-tile ${color === 'listing-activity' && t.colorValue !== null && t.colorValue >= 20 ? 'market-tile-dark' : ''}`}
                    style={{
                      left: `${t.x * 100}%`,
                      top: `${t.y * 100}%`,
                      width: `${t.width * 100}%`,
                      height: `${t.height * 100}%`,
                      background: tileColor(t.colorValue, color),
                    }}
                    aria-label={`${t.row.output.name}. ${color === 'price-change' ? 'Observed price change' : color === 'cost-spread' ? 'Provisional spread' : 'Inferred exits'}: ${t.colorValue === null ? 'unknown' : number(t.colorValue)}. ${sizeOptions.find(([id]) => id === size)?.[1]}: ${number(t.value)}.${t.row.change ? ` Observed from ${formatTimestamp(t.row.change.fromObservedAt)} to ${formatTimestamp(t.row.change.toObservedAt)}.` : ''}`}
                    title={`${t.row.output.name}\n${number(t.colorValue)} · ${number(t.value)} ${size}`}
                    onClick={(e) =>
                      open(t.row.output, 'market', e.currentTarget)
                    }
                  >
                    <span className="market-tile-content">
                      <strong>{t.row.output.name}</strong>
                      <span>
                        {color === 'price-change' && t.colorValue !== null ? (
                          `${t.colorValue > 0 ? '+' : ''}${number(t.colorValue)}%`
                        ) : color === 'cost-spread' ? (
                          t.row.spread ? (
                            <LibraryMoney price={t.row.spread} />
                          ) : (
                            'Not estimated'
                          )
                        ) : color === 'listing-activity' ? (
                          t.colorValue === null ? (
                            'Not measured'
                          ) : (
                            `${number(t.colorValue)} exits`
                          )
                        ) : (
                          'Unknown change'
                        )}
                      </span>
                      <small>
                        <LibraryMoney price={t.row.output.ask} />
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
          {catalog && !composition.groups.length ? (
            <p className="market-map-empty">
              No positive measured values for this size. Targets remain
              available below.
            </p>
          ) : null}
        </div>
        {composition.unsized.length ? (
          <nav
            className="market-unsized"
            aria-label="Targets without proportional size"
          >
            <span>
              No positive measured size · {composition.unsized.length}
            </span>
            {composition.unsized.map((r) => (
              <button
                key={r.output.id}
                onClick={(e) => open(r.output, 'market', e.currentTarget)}
                title={r.output.name}
              >
                {r.output.name}
                <small>
                  {size === 'captured-listings'
                    ? r.captured === 0
                      ? '0 captured'
                      : 'Unknown sample'
                    : 'No positive asking price'}
                </small>
              </button>
            ))}
          </nav>
        ) : null}
        <footer className="market-map-legend">
          <span>
            <i className="legend-negative" />{' '}
            {color === 'listing-activity' ? 'Low activity' : 'Negative'}
          </span>
          <span>
            <i className="legend-positive" />{' '}
            {color === 'listing-activity' ? 'Higher activity' : 'Positive'}
          </span>
          <span>
            <i className="legend-neutral" /> Measured zero
          </span>
          <span>
            <i className="legend-unknown" /> Unknown
          </span>
          <p>
            {color === 'cost-spread'
              ? 'Ask − modeled cost is provisional; selling costs and player time are not verified.'
              : color === 'price-change'
                ? 'Price change uses each target’s actual observed span within 7 days.'
                : 'Listing exits are inferred disappearances, not confirmed purchases.'}{' '}
            Overlapping target samples are not unique market share or sales
            volume.
          </p>
        </footer>
      </section>
      <div
        className="market-list-tabs"
        role="tablist"
        aria-label="Market data"
        onKeyDown={(e) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))
            return;
          e.preventDefault();
          const next =
            e.key === 'Home' ? false : e.key === 'End' ? true : !materialView;
          update('section', next ? 'materials' : '');
          document
            .getElementById(next ? 'market-materials-tab' : 'market-items-tab')
            ?.focus();
        }}
      >
        <button
          role="tab"
          id="market-items-tab"
          aria-controls="market-items-panel"
          tabIndex={materialView ? -1 : 0}
          aria-selected={!materialView}
          onClick={() => update('section', '')}
        >
          Items
        </button>
        <button
          role="tab"
          id="market-materials-tab"
          aria-controls="market-materials-panel"
          tabIndex={materialView ? 0 : -1}
          aria-selected={materialView}
          onClick={() => update('section', 'materials')}
        >
          Materials
        </button>
      </div>
      {materialView ? (
        <section
          className="market-materials"
          id="market-materials-panel"
          role="tabpanel"
          aria-labelledby="market-materials-tab"
        >
          {materialsError ? (
            <StatusPanel tone="danger" title="Material prices unavailable">
              <Button onClick={() => setRevision((n) => n + 1)}>Retry</Button>
            </StatusPanel>
          ) : !materials ? (
            <p>Loading material quotes…</p>
          ) : (
            <>
              <p>
                {materials.quotes.length} unit quotes ·{' '}
                {materials.league ?? 'League unavailable'} · checked{' '}
                {formatTimestamp(materials.checkedAt)}. Unit quotations, not
                expected total usage.
              </p>
              <div className="market-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Material</th>
                      <th>Unit price</th>
                      <th>Captured</th>
                      <th>Quote status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {materials.quotes.map((q) => (
                      <tr key={q.itemId}>
                        <td>{q.name}</td>
                        <td>{number(q.chaos)} c</td>
                        <td>{formatTimestamp(q.capturedAt)}</td>
                        <td>
                          {Date.parse(q.expiresAt) <= Date.now()
                            ? 'Expired'
                            : 'Current'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      ) : (
        <div
          id="market-items-panel"
          role="tabpanel"
          aria-labelledby="market-items-tab"
        >
          <div className="market-filters">
            <Input
              ref={searchRef}
              aria-label="Search market items"
              type="search"
              placeholder="Search items, bases or modifiers…"
              value={search}
              onChange={(e) => update('search', e.target.value)}
            />
            <label>
              Craft method
              <NativeSelect
                aria-label="Craft method family"
                value={family}
                onChange={(e) => update('family', e.target.value)}
              >
                <option value="all">All methods</option>
                {selection.families.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
                <option value="none" disabled>
                  No recipe · unavailable
                </option>
              </NativeSelect>
            </label>
            <label>
              Item class
              <NativeSelect
                aria-label="Item class"
                value={category}
                onChange={(e) => update('category', e.target.value)}
              >
                <option value="all">All classes</option>
                {selection.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <details className="market-modifier-filter">
              <summary>Modifiers{modifier ? ' · 1' : ''}</summary>
              <label>
                Saved requirement
                <NativeSelect
                  aria-label="Required modifier"
                  value={modifier}
                  onChange={(e) => update('modifier', e.target.value)}
                >
                  <option value="">Any requirement</option>
                  {availableModifiers.map(([id, m]) => (
                    <option key={id} value={id}>
                      {m.generationType} · {m.label}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <p>
                Filters saved target requirements, not verified affixes on every
                listing.
              </p>
            </details>
            <label className="market-estimate-filter">
              <input
                type="checkbox"
                checked={params.get('estimated') === '1'}
                onChange={(e) =>
                  update('estimated', e.target.checked ? '1' : '')
                }
              />
              With cost estimate
            </label>
          </div>
          {chips.length ? (
            <div className="market-filter-chips">
              {chips.map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => update(key!, '')}
                  aria-label={`Remove ${label} filter`}
                >
                  {label}
                  <XMarkIcon />
                </button>
              ))}
              <button onClick={clearFilters}>Clear filters</button>
            </div>
          ) : null}
          <section
            className="market-items-panel"
            aria-labelledby="market-items-title"
          >
            <header>
              <h2 id="market-items-title">
                Items{' '}
                <span>{catalog ? `${rows.length} targets` : 'Loading…'}</span>
              </h2>
              <div className="market-table-tools">
                <details>
                  <summary>Columns</summary>
                  <div className="market-column-menu">
                    {Object.entries(columnLabels).map(([key, label]) => (
                      <label key={key}>
                        <input
                          type="checkbox"
                          checked={columns.includes(key)}
                          onChange={(e) =>
                            setColumns((current) =>
                              e.target.checked
                                ? [...current, key]
                                : current.filter((c) => c !== key),
                            )
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </details>
                <label>
                  Density
                  <NativeSelect
                    aria-label="Density"
                    value={density}
                    onChange={(e) => changeDensity(e.target.value)}
                  >
                    <option value="comfortable">Comfortable</option>
                    <option value="compact">Compact</option>
                  </NativeSelect>
                </label>
                <button onClick={exportCsv}>
                  <ArrowDownTrayIcon />
                  Export
                </button>
              </div>
            </header>
            <div
              className="market-table-scroll"
              role="region"
              aria-label="Market items"
              tabIndex={0}
            >
              <table className="market-items-table">
                <caption className="sr-only">
                  Exact target market overview. Asking prices are not completed
                  sales.
                </caption>
                <thead>
                  <tr>
                    <th className="market-favorite-cell">
                      <span className="sr-only">Favorite</span>
                    </th>
                    <th
                      className="market-item-cell"
                      aria-sort={
                        sort === 'item'
                          ? direction === 1
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      <button onClick={() => sortBy('item')}>Item</button>
                    </th>
                    {visibleColumns.map((key) => (
                      <th
                        key={key}
                        className={
                          key === 'method' ? 'market-method-cell' : undefined
                        }
                        aria-sort={
                          sort === key
                            ? direction === 1
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                      >
                        <button onClick={() => sortBy(key)}>
                          {columnLabels[key]}
                          {sort === key ? (
                            <span aria-hidden="true">
                              {' '}
                              {direction === 1 ? '↑' : '↓'}
                            </span>
                          ) : null}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.output.id} data-market-target={row.output.id}>
                      <td className="market-favorite-cell">
                        <button
                          aria-label={`${favoriteIds.includes(row.output.id) ? 'Remove' : 'Add'} favorite: ${row.output.name}`}
                          aria-pressed={favoriteIds.includes(row.output.id)}
                          onClick={() =>
                            favorites.toggle(
                              row.output.id,
                              row.output.recipeIds,
                            )
                          }
                        >
                          <StarIcon />
                        </button>
                      </td>
                      <td className="market-item-cell">
                        <button
                          className="market-item-button"
                          title={row.output.name}
                          onClick={(e) =>
                            open(row.output, 'market', e.currentTarget)
                          }
                        >
                          <TargetArt
                            item={row.output.entry.itemPreview}
                            category={row.output.category}
                          />
                          <span>
                            <strong>{row.output.name}</strong>
                            <small>
                              {row.output.entry.recipe.baseName ??
                                row.output.entry.itemPreview?.name ??
                                itemClassLabel(row.output.category)}
                            </small>
                          </span>
                        </button>
                      </td>
                      {visibleColumns.map((key) => (
                        <td key={key}>{metric(row, key)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rows.length && catalog ? (
              <div className="market-empty">
                <h3>
                  {params.get('favorites') === '1'
                    ? 'No favorite targets match'
                    : 'No targets match'}
                </h3>
                <p>Adjust the filters to see more targets.</p>
                <Button onClick={clearFilters}>Clear filters</Button>
              </div>
            ) : null}
            <footer>
              Provisional estimate. Comparable sale price, selling costs and
              player time are not verified. Unknown values stay unranked.
            </footer>
          </section>
        </div>
      )}
      {favorites.error ? <p role="alert">{favorites.error}</p> : null}
      {selected ? (
        detail ? (
          <TargetDetailDialog
            output={detail}
            recipeId={params.get('recipe') ?? detail.selectedRecipeId}
            tab={params.get('detail') === 'recipe' ? 'recipe' : 'market'}
            leagueId={catalog?.data?.league?.id}
            leagueName={catalog?.data?.league?.name}
            onClose={close}
            onSelect={(id, tab) => {
              const next = new URLSearchParams(pendingParams.current);
              next.set('recipe', id);
              next.set('detail', tab);
              commitParams(next, { replace: true, state: location.state });
            }}
          />
        ) : (
          <div role="status">
            Selected target is unavailable.{' '}
            <Button onClick={close}>Back to market</Button>
          </div>
        )
      ) : null}
    </section>
  );
}
