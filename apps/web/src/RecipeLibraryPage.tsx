import type { CatalogEntry, CatalogResponse } from '@poe-worksmith/contracts';
import { useEffect, useRef, useState } from 'react';
import {
  useLocation,
  useNavigate,
  useSearchParams,
  useOutletContext,
} from 'react-router-dom';
import { createApiClient } from './apiClient.js';
import { Button, Input, NativeSelect } from './ui.js';
import { StatusPanel } from './components.js';
import { formatTimestamp } from './dateTime.js';
import { useFavorites } from './Watchlist.js';
import {
  itemClassLabel,
  selectRecipeLibrary,
  type RecipeLibraryOutput,
} from './recipeLibraryModel.js';
import {
  TargetDetailDialog,
  TargetArt,
  LibraryMoney,
} from './TargetDetailDialog.js';

const api = createApiClient();
export function RecipeLibraryPage({
  selectionView,
}: { selectionView?: string | undefined } = {}) {
  const [response, setResponse] = useState<CatalogResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const acceptCatalog = useOutletContext<
    ((data: NonNullable<CatalogResponse['data']>) => void) | undefined
  >();
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        const value = await api.getCatalog(
          AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        );
        if (!controller.signal.aborted) {
          if (value.data) {
            setResponse(value);
            acceptCatalog?.(value.data);
          }
          setFailed(!value.data);
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        inFlight = false;
      }
    }
    void load();
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('focus', refresh);
    const timer = setInterval(refresh, 60_000);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [revision, acceptCatalog]);
  return (
    <>
      {failed ? (
        <StatusPanel tone="danger" title="Recipes could not be refreshed">
          {response?.data
            ? 'Showing the last loaded catalogue. '
            : 'The catalogue is unavailable. '}
          <Button onClick={() => setRevision((n) => n + 1)}>Retry</Button>
        </StatusPanel>
      ) : null}
      {!response && !failed ? (
        <StatusPanel tone="info" title="Loading recipes" />
      ) : null}
      <RecipeLibrary
        selectionView={selectionView}
        entries={response?.data?.entries ?? []}
        loading={!response && !failed}
        stale={response?.isStale ?? false}
      />
    </>
  );
}

export function RecipeLibrary({
  entries,
  loading = false,
  stale = false,
  selectionView,
}: {
  entries: CatalogEntry[];
  loading?: boolean;
  stale?: boolean;
  selectionView?: string | undefined;
}) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const favorites = useFavorites();
  const search = params.get('search') ?? '';
  const category = params.get('category') ?? 'all';
  const family = params.get('family') ?? 'all';
  const sort = params.get('sort') ?? 'catalogue';
  const estimatesOnly = params.get('estimated') === '1';
  const favoritesOnly = params.get('favorites') === '1';
  const currency =
    (params.get('currency') ?? params.get('profitCurrency')) === 'divine'
      ? 'divine'
      : 'chaos';
  const selectedTarget = params.get('target');
  const searchRef = useRef<HTMLInputElement>(null);
  const opener = useRef<string | null>(null);
  const scroll = useRef(0);
  const closing = useRef(false);
  const result = selectRecipeLibrary(entries, {
    search,
    category,
    family,
    sort,
    estimatesOnly,
    favoritesOnly,
    favoriteIds: favorites.ids,
    currency,
  });
  const detail = selectedTarget
    ? selectRecipeLibrary(
        entries.filter((e) => e.recipe.targetSignature === selectedTarget),
        { search, family, currency },
      ).outputs.find((o) => o.id === selectedTarget)
    : undefined;
  const updatedAt = entries
    .flatMap((e) => [
      e.readiness?.capturedAt,
      e.evaluation.source?.capturedAt,
      e.evaluation.evaluatedAt,
      e.snapshot?.capturedAt,
    ])
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1);
  function update(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (!value || value === 'all' || value === 'catalogue') next.delete(key);
    else next.set(key, value);
    for (const legacy of ['view', 'source', 'minRoi', 'minProfit'])
      next.delete(legacy);
    setParams(next, { replace: true });
  }
  function clearAll() {
    const next = new URLSearchParams(params);
    for (const key of [
      'search',
      'category',
      'family',
      'favorites',
      'estimated',
      'source',
      'view',
      'minRoi',
      'minProfit',
    ])
      next.delete(key);
    setParams(next, { replace: true });
  }
  function open(
    output: RecipeLibraryOutput,
    recipeId: string,
    trigger: string,
  ) {
    if (selectionView) {
      void navigate(
        `${['budget', 'item'].includes(selectionView) ? '/' : `/recipes/${encodeURIComponent(recipeId)}`}?recipe=${encodeURIComponent(recipeId)}&view=${encodeURIComponent(selectionView)}`,
      );
      return;
    }
    closing.current = false;
    opener.current = trigger;
    scroll.current = window.scrollY;
    const next = new URLSearchParams(params);
    next.set('target', output.id);
    next.set('recipe', recipeId);
    next.set('detail', 'recipe');
    setParams(next, { state: { recipeLibraryDialog: true } });
  }
  function close() {
    if (closing.current) return;
    closing.current = true;
    if (location.state?.recipeLibraryDialog) void navigate(-1);
    else {
      const next = new URLSearchParams(params);
      for (const key of ['target', 'recipe', 'detail']) next.delete(key);
      setParams(next, { replace: true });
    }
  }
  useEffect(() => {
    closing.current = false;
    if (selectedTarget || !opener.current) return;
    (document.getElementById(opener.current) ?? searchRef.current)?.focus({
      preventScroll: true,
    });
    window.scrollTo(0, scroll.current);
    opener.current = null;
  }, [selectedTarget]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const element = event.target;
      if (
        event.key !== '/' ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        selectedTarget ||
        (element instanceof HTMLElement &&
          (element.isContentEditable ||
            element.closest('input, textarea, select')))
      )
        return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [selectedTarget]);
  const chips: { key: string; label: string }[] = [];
  if (search) chips.push({ key: 'search', label: `Search: ${search}` });
  if (category !== 'all')
    chips.push({ key: 'category', label: itemClassLabel(category) });
  if (family !== 'all')
    chips.push({
      key: 'family',
      label: result.families.find((f) => f.id === family)?.label ?? family,
    });
  if (estimatesOnly)
    chips.push({ key: 'estimated', label: 'With cost estimate' });
  if (favoritesOnly) chips.push({ key: 'favorites', label: 'Favorites' });
  return (
    <>
      <section
        className="category-library"
        aria-labelledby="recipes-heading"
        aria-busy={loading}
      >
        <header className="library-heading">
          <div>
            <h1 id="recipes-heading">
              {favoritesOnly ? 'Favorite recipes' : 'Recipes'}
            </h1>
            <p>Find a final item. Choose how to craft it.</p>
          </div>
          {updatedAt ? (
            <small className="library-timestamp">
              {stale ? 'Stale data' : 'Data as of'} ·{' '}
              <time dateTime={updatedAt}>{formatTimestamp(updatedAt)}</time>
            </small>
          ) : null}
        </header>
        <div className="library-controls">
          <label className="library-search">
            <span className="sr-only">Search items or modifiers</span>
            <Input
              ref={searchRef}
              type="search"
              aria-label="Search items or modifiers"
              placeholder="Search items or modifiers…"
              value={search}
              onChange={(e) => update('search', e.target.value)}
            />
            <kbd aria-hidden="true">/</kbd>
          </label>
          <label>
            Craft method
            <NativeSelect
              aria-label="Craft method"
              value={family}
              onChange={(e) => update('family', e.target.value)}
              aria-describedby="library-count-help"
            >
              <option value="all">All craft methods</option>
              {result.families.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label} ({f.count})
                </option>
              ))}
            </NativeSelect>
          </label>
          <label>
            Sort
            <NativeSelect
              aria-label="Sort"
              value={sort}
              onChange={(e) => update('sort', e.target.value)}
            >
              <option value="catalogue">Catalogue order</option>
              <option value="cost">Lowest craft cost</option>
              <option value="ask">Highest asking price</option>
              <option value="name">Item name</option>
            </NativeSelect>
          </label>
          <label className="library-estimated">
            <input
              type="checkbox"
              checked={estimatesOnly}
              onChange={(e) => update('estimated', e.target.checked ? '1' : '')}
            />
            With cost estimate
          </label>
        </div>
        {chips.length ? (
          <div className="library-chips" aria-label="Active filters">
            {chips.map(({ key, label }) => (
              <Button
                key={key}
                onClick={() => update(key, '')}
                aria-label={`Remove ${label} filter`}
              >
                {label} ×
              </Button>
            ))}
            <Button onClick={clearAll}>Clear all</Button>
          </div>
        ) : null}
        <p className="sr-only" id="library-count-help">
          Category and craft method counts describe the full recipe catalogue,
          independent of filters.
        </p>
        <nav
          className="library-categories"
          aria-label="Item classes"
          aria-describedby="library-count-help"
        >
          <Button
            aria-pressed={category === 'all'}
            onClick={() => update('category', 'all')}
          >
            All item classes <span>{result.total}</span>
          </Button>
          {result.categories.map((c) => (
            <Button
              key={c.id}
              aria-pressed={category === c.id}
              onClick={() => update('category', c.id)}
            >
              {c.label} <span>{c.count}</span>
            </Button>
          ))}
        </nav>
        <p className="library-summary" role="status" aria-live="polite">
          <strong>{result.outputs.length} outputs</strong>
          <span>{result.methodCount} crafting methods</span>
          <span>One item, multiple routes.</span>
        </p>
        {!loading && !result.outputs.length ? (
          <StatusPanel
            tone="info"
            title={
              entries.length ? 'No matching recipes' : 'No recipes available'
            }
          >
            {entries.length
              ? 'Try another item class or craft method, or clear the filters.'
              : 'Recipe-bearing targets will appear here when the catalogue is available.'}
            {chips.length ? (
              <Button onClick={clearAll}>Clear all filters</Button>
            ) : null}
          </StatusPanel>
        ) : null}
        <div className="library-shelves">
          {result.categories.map((c) => {
            const outputs = result.outputs.filter((o) => o.category === c.id);
            return outputs.length ? (
              <section
                className="library-shelf"
                key={c.id}
                aria-labelledby={`shelf-${c.id}`}
              >
                <header>
                  <h2 id={`shelf-${c.id}`}>{c.label}</h2>
                  <span>{outputs.length} outputs</span>
                </header>
                <ul>
                  {outputs.map((output) => {
                    const trigger = `target-${output.id}`;
                    const item = output.entry.itemPreview;
                    const passives = item?.properties.find(
                      (p) => p.id === 'passive-count',
                    )?.value;
                    return (
                      <li key={output.id} data-target-id={output.id}>
                        <TargetArt item={item} category={c.label} />
                        <div className="library-identity">
                          <button
                            id={trigger}
                            className="library-output-name"
                            onClick={() =>
                              open(output, output.selectedRecipeId, trigger)
                            }
                          >
                            {output.name}
                          </button>
                          <p>
                            {item?.name ??
                              output.entry.recipe.baseName ??
                              c.label}
                            {passives
                              ? ` · ${passives} passives`
                              : item?.itemLevel
                                ? ` · ilvl ${item.itemLevel}`
                                : ''}
                          </p>
                          <div className="library-routes">
                            {output.methods.map((entry) => {
                              const id = `route-${entry.recipe.id}`;
                              return (
                                <button
                                  id={id}
                                  key={entry.recipe.id}
                                  aria-label={`Open ${entry.recipe.methodName ?? entry.recipe.craftMethod} recipe for ${output.name}`}
                                  onClick={() =>
                                    open(output, entry.recipe.id, id)
                                  }
                                >
                                  {entry.recipe.methodName ??
                                    entry.recipe.craftMethod}
                                  <span aria-hidden="true"> ›</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <div
                          className="library-cost"
                          title={`${output.coverage.estimated}/${output.coverage.total} matching routes estimated. Lowest known modeled cost in ${currency}; unknown alternatives are unranked.`}
                        >
                          <strong>
                            <LibraryMoney price={output.cost} />
                          </strong>
                          <small>
                            {output.cost ? 'Cost from' : 'Not estimated'}
                          </small>
                          <span className="sr-only">
                            {output.coverage.estimated} of{' '}
                            {output.coverage.total} matching routes estimated in{' '}
                            {currency}. Unknown alternatives are unranked.
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null;
          })}
        </div>
        <footer className="library-footer">
          Modeled costs are estimates. Asking prices are not confirmed sales.{' '}
          {stale
            ? 'Saved data may be out of date.'
            : 'Unknown estimates remain unranked.'}
        </footer>
      </section>
      {selectedTarget ? (
        detail ? (
          <TargetDetailDialog
            output={detail}
            recipeId={params.get('recipe') ?? detail.selectedRecipeId}
            tab={params.get('detail') === 'market' ? 'market' : 'recipe'}
            onClose={close}
            onSelect={(recipeId, tab) => {
              const next = new URLSearchParams(params);
              next.set('recipe', recipeId);
              next.set('detail', tab);
              setParams(next, { replace: true, state: location.state });
            }}
          />
        ) : !loading ? (
          <StatusPanel
            tone="warning"
            title="Target is unavailable in this catalogue scope"
          >
            <Button onClick={close}>Return to recipes</Button>
          </StatusPanel>
        ) : null
      ) : null}
    </>
  );
}
