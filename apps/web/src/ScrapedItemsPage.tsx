import type {
  ScrapedItem,
  ScrapedItemsResponse,
} from '@poe-worksmith/contracts';
import {
  CheckCircleIcon,
  MinusCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'react-router-dom';

import { StatusPanel } from './components.js';
import { ScrapedItemEditor } from './ScrapedItemEditor.js';
import { SettingsNav } from './SettingsNav.js';
import { formatTimestamp } from './dateTime.js';
import { scrapedSearchName } from './scrapedItemsModel.js';
import {
  createScrapedItemsClient,
  type ScrapedItemsClient,
} from './scrapedItemsClient.js';
import { Button, Input, NativeSelect } from './ui.js';
import './scrapedItems.css';

type Data = ScrapedItemsResponse['data'];

/** Two searches can share a base, so the recipes using one are what tell them apart. */
function usedBy(item: ScrapedItem) {
  const titles = [...new Set(item.recipes.map(({ title }) => title))];
  if (!titles.length) return 'No active recipe';
  const shown = titles.slice(0, 2).join(', ');
  return titles.length > 2 ? `${shown} +${titles.length - 2} more` : shown;
}

function describe(item: ScrapedItem) {
  if (item.query.status === 'blocked') return 'Cannot be built';
  if (!item.recipes.length) return 'No active recipes';
  if (!item.schedule) return 'Not scheduled yet';
  if (!item.latestCapture) return 'No capture yet';
  return item.latestCapture.coverage === 'complete'
    ? 'Complete capture'
    : 'Partial capture';
}

/** Unique stored Trade listing IDs seen for this query in the current league; not sales, not worker health. */
function listingEvidence(item: ScrapedItem) {
  const recent = item.recentListings;
  if (item.query.status === 'blocked') {
    return {
      tone: 'blocked',
      Icon: XCircleIcon,
      label: 'Blocked',
      detail: 'This search cannot be built.',
    };
  }
  if (!recent) {
    return {
      tone: 'unavailable',
      Icon: MinusCircleIcon,
      label: 'Not checked · 7d',
      detail: 'No verified capture for this search in the last 7 days.',
    };
  }
  const label = `${recent.count} listing${recent.count === 1 ? '' : 's'} · 7d`;
  return {
    tone: recent.count > 0 ? 'positive' : 'zero',
    Icon: recent.count > 0 ? CheckCircleIcon : MinusCircleIcon,
    label,
    detail: `${recent.count} unique Trade listings found by this search in the current league, ${formatTimestamp(recent.from)} — ${formatTimestamp(recent.to)}. Repeated captures count once.`,
  };
}

/** Settings → Scraped items: the searches the collector runs and the requirements behind each. */
export function ScrapedItemsPage({
  client: provided,
}: {
  client?: ScrapedItemsClient;
}) {
  const client = useMemo(
    () => provided ?? createScrapedItemsClient(),
    [provided],
  );
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [role, setRole] = useState<'all' | 'base' | 'output'>('all');
  const [filter, setFilter] = useState('');
  const selectedId = params.get('item');
  const loadGeneration = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const generation = ++loadGeneration.current;
      try {
        const next = await client.list(signal);
        if (signal?.aborted || generation !== loadGeneration.current) return;
        setData(next.data);
        setError('');
      } catch (cause) {
        if (signal?.aborted || generation !== loadGeneration.current) return;
        setError(
          cause instanceof Error
            ? cause.message
            : 'Scraped items are unavailable.',
        );
      }
    },
    [client],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (data?.items ?? [])
      .filter((item) => role === 'all' || item.role === role)
      .filter(
        (item) =>
          !needle ||
          [
            scrapedSearchName(item),
            ...(item.spec.marketSearchCategory
              ? []
              : [item.baseName ?? '', item.baseId]),
            ...item.recipes.map(({ title }) => title),
          ]
            .join(' ')
            .toLowerCase()
            .includes(needle),
      )
      .sort(
        (a, b) =>
          scrapedSearchName(a).localeCompare(scrapedSearchName(b)) ||
          a.role.localeCompare(b.role) ||
          (a.recipes[0]?.title ?? '').localeCompare(b.recipes[0]?.title ?? ''),
      );
  }, [data, filter, role]);
  const selected = data?.items.find(({ id }) => id === selectedId) ?? null;
  const panelRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    let frame = 0;
    const fit = () => {
      frame = 0;
      const available = Math.max(
        320,
        window.innerHeight -
          Math.max(16, panel.getBoundingClientRect().top) -
          16,
      );
      panel.style.setProperty('--scraped-list-height', `${available}px`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(fit);
    };
    fit();
    const observer = new ResizeObserver(schedule);
    observer.observe(panel.closest('main') ?? panel);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule);
      cancelAnimationFrame(frame);
    };
  }, [data !== null]);
  // Keep the selected search in view inside the scroll region (e.g. when opened from a link).
  useEffect(() => {
    const list = listRef.current;
    const entry = list?.querySelector('[aria-current="true"]');
    const region = list?.parentElement;
    if (!entry || !region) return;
    const bounds = region.getBoundingClientRect(),
      row = entry.getBoundingClientRect();
    if (row.top < bounds.top) region.scrollTop += row.top - bounds.top;
    else if (row.bottom > bounds.bottom)
      region.scrollTop += row.bottom - bounds.bottom;
  }, [selectedId, data !== null]);

  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('item', id);
    setParams(next, { replace: true });
  };
  const replaceItem = useCallback((item: ScrapedItem) => {
    ++loadGeneration.current;
    setData((current) =>
      current
        ? {
            ...current,
            items: current.items.map((candidate) =>
              candidate.id === item.id ? item : candidate,
            ),
          }
        : current,
    );
  }, []);

  return (
    <>
      <header className="catalog-heading">
        <div>
          <h1>Scraped items</h1>
          <p>
            The Trade searches the collector runs for your recipes: what each
            one requires, which recipes share it, and what the last capture
            actually contained.
          </p>
        </div>
      </header>
      <SettingsNav />
      {error ? (
        <StatusPanel tone="danger" title="Scraped items are unavailable">
          {error}{' '}
          <Button type="button" onClick={() => void load()}>
            Try again
          </Button>
        </StatusPanel>
      ) : null}
      {!data && !error ? (
        <p role="status" className="scraped-hint">
          Loading scraped items…
        </p>
      ) : null}
      {data ? (
        <div className="scraped-items">
          <section
            ref={panelRef}
            className="scraped-items__list"
            aria-labelledby="scraped-list-heading"
          >
            <h2 id="scraped-list-heading">
              Searches{' '}
              <span className="scraped-hint">
                ({visible.length} of {data.items.length})
              </span>
            </h2>
            {data.collectionsPaused ? (
              <p className="scraped-note" role="status">
                Collection is paused. Searches can be edited but not tested.
              </p>
            ) : null}
            {!data.league ? (
              <p className="scraped-note" role="status">
                The current league is not resolved, so Trade links and tests are
                unavailable.
              </p>
            ) : null}
            <div className="scraped-filters">
              <label>
                Filter
                <Input
                  type="search"
                  value={filter}
                  placeholder="Base or recipe name"
                  onChange={(event) => setFilter(event.target.value)}
                />
              </label>
              <label>
                Kind
                <NativeSelect
                  value={role}
                  onChange={(event) =>
                    setRole(event.target.value as typeof role)
                  }
                >
                  <option value="all">Base and output</option>
                  <option value="base">Starting bases</option>
                  <option value="output">Finished outputs</option>
                </NativeSelect>
              </label>
            </div>
            {visible.length ? (
              <div
                className="scraped-list-scroll"
                role="region"
                aria-label="Search results"
                tabIndex={0}
              >
                <ul className="scraped-list" ref={listRef}>
                  {visible.map((item) => {
                    const evidence = listingEvidence(item);
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          data-item-id={item.id}
                          className="scraped-list__item"
                          aria-current={
                            item.id === selectedId ? 'true' : undefined
                          }
                          onClick={() => select(item.id)}
                        >
                          <span className="scraped-list__title">
                            {scrapedSearchName(item)}
                          </span>
                          <span className="scraped-hint">{usedBy(item)}</span>
                          <span className="scraped-hint">
                            {item.role === 'base'
                              ? 'Starting base'
                              : 'Finished output'}{' '}
                            · {item.recipes.length} recipe
                            {item.recipes.length === 1 ? '' : 's'}
                            {item.modifiers.length
                              ? ` · ${item.modifiers.length} modifier${item.modifiers.length === 1 ? '' : 's'}`
                              : ''}
                          </span>
                          <span className="scraped-hint">{describe(item)}</span>
                          <span
                            className={`scraped-evidence scraped-evidence--${evidence.tone}`}
                            title={evidence.detail}
                          >
                            <evidence.Icon aria-hidden="true" />
                            {evidence.label}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <p className="scraped-hint">No search matches this filter.</p>
            )}
          </section>
          <section
            className="scraped-items__detail"
            aria-label="Selected search"
          >
            {selected ? (
              <ScrapedItemEditor
                key={selected.id}
                client={client}
                collectionsPaused={data.collectionsPaused}
                item={selected}
                leagueName={data.league?.name ?? null}
                recipes={data.recipes}
                onItemChanged={replaceItem}
                onReload={() => load()}
              />
            ) : (
              <p className="scraped-hint">
                Choose a search to see and edit its requirements.
              </p>
            )}
          </section>
        </div>
      ) : null}
    </>
  );
}
