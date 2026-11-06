import type {
  TradeDashboardItem,
  TradeDashboardRange,
} from '@poe-worksmith/contracts';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { createApiClient } from './apiClient.js';
import { StatusPanel } from './components.js';
import { formatUtc } from './PriceTrendChart.js';
import { TradeItemHistory } from './TradeItemHistory.js';
import './tradeDashboard.css';

const api = createApiClient();
const rate = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const axisLabel = new Intl.NumberFormat('en', { maximumSignificantDigits: 3 });
const shortTime = new Intl.DateTimeFormat('en-GB', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

type RankedItem = TradeDashboardItem & {
  latest: NonNullable<TradeDashboardItem['latest']>;
  exitsPerDay: number;
  priceDivine: number;
};

function divineAsk(item: RankedItem) {
  return `${axisLabel.format(item.priceDivine)} div`;
}

type Sort = 'turnover' | 'ask' | 'change' | 'visible' | 'fresh' | 'age';
const columns: [Sort, string][] = [
  ['ask', 'Median ask'],
  ['turnover', 'Exits / day'],
  ['change', 'Rate change'],
  ['visible', 'In latest'],
  ['fresh', 'First seen'],
  ['age', 'Visible ≥48h'],
];

function metric(item: RankedItem, sort: Sort) {
  switch (sort) {
    case 'turnover':
      return item.exitsPerDay;
    case 'ask':
      return item.priceDivine;
    case 'change':
      return item.changePerDay;
    case 'visible':
      return item.latest.captured;
    case 'fresh':
      return item.firstSeen;
    case 'age':
      return item.visible48h;
  }
}

function TurnoverMap({
  items,
  selected,
  onSelect,
}: {
  items: RankedItem[];
  selected: RankedItem;
  onSelect(id: string): void;
}) {
  const min = Math.min(...items.map(({ priceDivine }) => priceDivine));
  const max = Math.max(...items.map(({ priceDivine }) => priceDivine));
  const ticks = Array.from(
    {
      length:
        Math.ceil(Math.log10(max * 1.35)) -
        Math.floor(Math.log10(min / 1.35)) +
        1,
    },
    (_, index) => 10 ** (Math.floor(Math.log10(min / 1.35)) + index),
  ).flatMap((value) => [value, value * 2, value * 5]);
  const floor =
    ticks.filter((value) => value > 0 && value <= min / 1.25).at(-1) ?? min;
  const ceiling = ticks.find((value) => value >= max * 1.25) ?? max * 1.25;
  const logSpan = Math.log(ceiling) - Math.log(floor);
  const x = (value: number) =>
    ((Math.log(value) - Math.log(floor)) / logSpan) * 100;
  const priceTicks = ticks.filter(
    (value) => value >= floor && value <= ceiling,
  );
  const stride = Math.max(1, Math.ceil(priceTicks.length / 9));
  const peak = Math.max(1, ...items.map((item) => item.exitsPerDay));
  const magnitude = 10 ** Math.floor(Math.log10(peak / 4));
  const step = Math.ceil((peak * 1.1) / 4 / magnitude) * magnitude;
  const yMax = step * 4;
  const leading = new Set(
    [...items]
      .sort((left, right) => right.exitsPerDay - left.exitsPerDay)
      .slice(0, 6)
      .map((item) => item.id),
  );
  // Leave the price coordinate fixed; a short stem shows the true rate when marks overlap.
  const gap = 5.5;
  const marks: {
    item: RankedItem;
    left: number;
    anchor: number;
    bottom: number;
  }[] = [];
  const offsets = [
    0,
    ...Array.from({ length: Math.ceil(100 / gap) }, (_, index) => [
      (index + 1) * gap,
      -(index + 1) * gap,
    ]).flat(),
  ];
  for (const item of items) {
    const left = x(item.priceDivine);
    const anchor = (item.exitsPerDay / yMax) * 100;
    const offset =
      offsets.find((offset) => {
        const bottom = anchor + offset;
        return (
          bottom >= 0 &&
          bottom <= 100 &&
          marks.every(
            (mark) =>
              Math.abs(mark.left - left) >= gap ||
              Math.abs(mark.bottom - bottom) >= gap - 0.001,
          )
        );
      }) ?? 0;
    marks.push({ item, left, anchor, bottom: anchor + offset });
  }
  return (
    <div className={`trade-map${items.length > 12 ? ' trade-map--dense' : ''}`}>
      <p className="trade-map__axis">Sustained disappearances / 24h</p>
      <div
        className="trade-map__graph"
        role="group"
        aria-label="Price and turnover plot"
      >
        {[0, 1, 2, 3, 4].map((tick) => (
          <span
            className="trade-map__guide trade-map__guide--y"
            aria-hidden="true"
            key={tick}
            style={{ bottom: `${tick * 25}%` }}
          >
            <span>{axisLabel.format(tick * step)}</span>
          </span>
        ))}
        {priceTicks.map((value, index) =>
          index % stride === 0 ? (
            <span
              className="trade-map__guide trade-map__guide--x"
              aria-hidden="true"
              key={value}
              style={{ left: `${x(value)}%` }}
            >
              <span>{axisLabel.format(value)}</span>
            </span>
          ) : null,
        )}
        {marks.map(({ item, left, anchor, bottom }) =>
          anchor === bottom ? null : (
            <span
              aria-hidden="true"
              className="trade-map__anchor"
              key={item.id}
              style={{
                left: `${left}%`,
                bottom: `${Math.min(anchor, bottom)}%`,
                height: `${Math.abs(anchor - bottom)}%`,
              }}
            />
          ),
        )}
        {marks.map(({ item, left, bottom }) => (
          <button
            aria-label={`${item.name}, ${divineAsk(item)}, ${rate.format(item.exitsPerDay)} sustained exits per day`}
            aria-pressed={item.id === selected.id}
            className={`trade-map__point${left > 78 ? ' trade-map__point--label-left' : ''}${leading.has(item.id) ? ' trade-map__point--leading' : ''}`}
            key={item.id}
            onClick={() => onSelect(item.id)}
            style={{ left: `${left}%`, bottom: `${bottom}%` }}
            title={item.name}
            type="button"
          >
            <span className="trade-map__label" aria-hidden="true">
              {item.name.split(' · ')[0] ?? item.name}
            </span>
          </button>
        ))}
      </div>
      <p className="trade-map__axis trade-map__axis--price">
        Latest median ask · divines (log scale)
      </p>
      {marks.some((mark) => mark.anchor !== mark.bottom) ? (
        <p className="trade-map__axis trade-map__overlap">
          Short stems mark the exact rate of overlapping points.
        </p>
      ) : null}
    </div>
  );
}

export function TradeDashboard({ league }: { league: string | undefined }) {
  const [params, setParams] = useSearchParams();
  const range: TradeDashboardRange =
    params.get('tradeRange') === '7d' ? '7d' : '24h';
  const target = params.get('tradeTarget');
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof api.getTradeDashboard>
  > | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(target);
  const openHistory = useRef<HTMLButtonElement>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('turnover');
  const [ascending, setAscending] = useState(false);
  useEffect(() => {
    if (target) return;
    let active = true;
    api
      .getTradeDashboard(range, league)
      .then((response) => {
        if (active) {
          setResult(response);
          setFailed(false);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [range, league, target]);

  const data =
    result?.data.range === range && (!league || result.data.league === league)
      ? result.data
      : null;
  const search = query.trim().toLowerCase();
  const items = (data?.items ?? []).flatMap<RankedItem>((item) => {
    const { latest, exitsPerDay } = item;
    const priceDivine =
      latest?.currency === 'divine' ? latest.ask : item.chartAskDivine;
    if (
      !latest ||
      exitsPerDay === null ||
      priceDivine == null ||
      priceDivine <= 0 ||
      !`${item.name} ${item.slot}`.toLowerCase().includes(search)
    )
      return [];
    return [{ ...item, latest, exitsPerDay, priceDivine }];
  });
  const rows = [...items].sort((left, right) => {
    const a = metric(left, sort);
    const b = metric(right, sort);
    if (a === null || b === null)
      return (
        Number(a === null) - Number(b === null) ||
        left.name.localeCompare(right.name)
      );
    return (ascending ? a - b : b - a) || left.name.localeCompare(right.name);
  });
  const selected = items.find((item) => item.id === selectedId) ?? rows[0];
  function changeRange(next: TradeDashboardRange) {
    setFailed(false);
    setParams(
      (previous) => {
        const nextParams = new URLSearchParams(previous);
        nextParams.set('tradeRange', next);
        return nextParams;
      },
      { replace: true },
    );
  }
  function openItem(id: string) {
    setSelectedId(id);
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set('tradeTarget', id);
        return next;
      },
      { preventScrollReset: true },
    );
  }

  return (
    <section className="trade-dashboard" aria-label="Trade market">
      <div className="trade-dashboard__scope">
        {target ? (
          <span>Trade capture history</span>
        ) : (
          <label className="trade-dashboard__search">
            <span>Find an item</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Base or item name"
            />
          </label>
        )}
        <div className="trade-dashboard__window">
          {data ? (
            <span>
              {shortTime.format(new Date(data.windowStart))} –{' '}
              {shortTime.format(new Date(data.windowEnd))} UTC
            </span>
          ) : null}
          <div
            className="trade-dashboard__ranges"
            role="group"
            aria-label="Trade observation window"
          >
            {(['24h', '7d'] as const).map((value) => (
              <button
                key={value}
                aria-pressed={value === range}
                onClick={() => changeRange(value)}
                type="button"
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      </div>
      {target ? (
        <TradeItemHistory
          range={range}
          league={league ?? data?.league ?? undefined}
          target={target}
          onBack={() => {
            setParams(
              (previous) => {
                const next = new URLSearchParams(previous);
                next.delete('tradeTarget');
                return next;
              },
              { replace: true },
            );
          }}
        />
      ) : failed ? (
        <StatusPanel tone="warning" title="Trade dashboard unavailable">
          The market captures could not be loaded.
        </StatusPanel>
      ) : !data ? (
        <StatusPanel tone="info" title="Loading Trade market" />
      ) : (
        <>
          <div className="trade-dashboard__card">
            <header className="trade-dashboard__heading">
              <div>
                <h3>Price vs. estimated turnover</h3>
                <p>
                  Higher means more sustained disappearances per day. Farther
                  right means a higher asking price.
                </p>
              </div>
              <span className="trade-dashboard__badge">Sales proxy</span>
            </header>
            {selected ? (
              <div className="trade-dashboard__map-layout">
                <TurnoverMap
                  items={items}
                  selected={selected}
                  onSelect={(id) => {
                    setSelectedId(id);
                    openHistory.current?.focus();
                  }}
                />
                <aside
                  className="trade-dashboard__selection"
                  aria-label="Selected Trade target"
                >
                  <p className="trade-dashboard__cohort">Selected cohort</p>
                  <h4>{selected.name}</h4>
                  <dl>
                    <div>
                      <dt>Median ask</dt>
                      <dd>{divineAsk(selected)}</dd>
                    </div>
                    <div>
                      <dt>Sustained exits / day</dt>
                      <dd>{rate.format(selected.exitsPerDay)}</dd>
                    </div>
                    <div>
                      <dt>Settled coverage</dt>
                      <dd>{rate.format(selected.settledHours)}h</dd>
                    </div>
                  </dl>
                  <button
                    className="trade-dashboard__primary"
                    onClick={() => openItem(selected.id)}
                    ref={openHistory}
                    type="button"
                  >
                    Open item history <span aria-hidden="true">→</span>
                  </button>
                </aside>
              </div>
            ) : (
              <p className="trade-dashboard__message">
                {search
                  ? 'No comparable items match this search.'
                  : 'No items have both a comparable asking price in divines and enough turnover data for this window.'}
              </p>
            )}
          </div>
          <div className="trade-dashboard__card">
            <header className="trade-dashboard__heading">
              <div>
                <h3>Tracked items</h3>
                <p>
                  Same items as on the map. Chaos asks are converted to divines
                  using a recent exchange observation for this league.
                </p>
              </div>
              <span className="trade-dashboard__count" aria-live="polite">
                {rows.length} {rows.length === 1 ? 'item' : 'items'}
              </span>
            </header>
            <div
              className="trade-dashboard__table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Scrollable Trade ranking"
            >
              <table className="trade-dashboard__table">
                <thead>
                  <tr>
                    <th scope="col">Item cohort</th>
                    {columns.map(([key, label]) => (
                      <th
                        scope="col"
                        key={key}
                        aria-sort={
                          sort === key
                            ? ascending
                              ? 'ascending'
                              : 'descending'
                            : undefined
                        }
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setAscending(sort === key && !ascending);
                            setSort(key);
                          }}
                        >
                          {label}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => (
                    <tr key={item.id}>
                      <th scope="row">
                        <button onClick={() => openItem(item.id)} type="button">
                          {item.name}
                        </button>
                        <small>
                          {formatUtc(item.latest.at)} · {item.latest.coverage}{' '}
                          coverage
                        </small>
                      </th>
                      {columns.map(([key]) => {
                        const value = metric(item, key);
                        return (
                          <td key={key}>
                            {key === 'ask'
                              ? divineAsk(item)
                              : value === null
                                ? '—'
                                : (key === 'change' && value > 0 ? '+' : '') +
                                  rate.format(value)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="trade-dashboard__message">
              Rate change compares with the previous equal window. First seen
              counts distinct listing IDs in retained captures. Visible ≥48h
              requires a complete sequence of observations.
            </p>
          </div>
          <details className="trade-dashboard__method">
            <summary>How turnover is estimated</summary>
            <p>
              An absent listing contributes after two further complete captures
              of the same search. A listing seen again in retained history is
              excluded. The rate uses settled observation time. Ranking requires
              a recent complete capture and at least half of the window covered.
              Confirmed sales and paid prices are unavailable.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
