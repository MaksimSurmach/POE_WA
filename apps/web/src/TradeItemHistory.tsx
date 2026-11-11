import { Button, NativeSelect, TableSurface } from './ui.js';
import type {
  TradeDashboardPoint,
  TradeDashboardRange,
} from '@poe-worksmith/contracts';
import { useEffect, useRef, useState } from 'react';

import { createApiClient } from './apiClient.js';
import { StatusPanel } from './components.js';
import { formatAmount, formatUtc } from './PriceTrendChart.js';

const api = createApiClient();
const series = [
  {
    label: 'In capture',
    style: 'captured',
    value: (point: TradeDashboardPoint) =>
      point.coverage === 'complete' ? point.captured : null,
  },
  {
    label: 'First seen',
    style: 'fresh',
    value: (point: TradeDashboardPoint) => point.firstSeen,
  },
  {
    label: 'Disappeared (−)',
    style: 'missing',
    value: (point: TradeDashboardPoint) =>
      point.missing === null ? null : -point.missing,
  },
];

function ListingActivityChart({
  points,
  selected,
}: {
  points: TradeDashboardPoint[];
  selected: string;
}) {
  const max = Math.max(
    1,
    ...points.map((point) =>
      Math.max(point.captured ?? 0, point.firstSeen ?? 0),
    ),
  );
  const min = -Math.max(1, ...points.map((point) => point.missing ?? 0));
  const times = points.map((point) => Date.parse(point.at));
  const first = times[0] ?? 0;
  const span = (times.at(-1) ?? first) - first;
  const x = (index: number) =>
    span ? 42 + (((times[index] ?? first) - first) * 578) / span : 331;
  const y = (value: number) => 14 + ((max - value) * 143) / (max - min);
  const marker = points.findIndex((point) => point.id === selected);
  const last = points.at(-1);
  return (
    <figure className="trade-history__chart">
      <figcaption>
        {series.map((line) => (
          <span className={`trade-history__${line.style}`} key={line.style}>
            {line.label}
          </span>
        ))}
      </figcaption>
      <svg
        aria-label="Captured, first-seen and disappeared listings per observation. Exact values are in the capture table."
        role="img"
        viewBox="0 0 640 170"
        preserveAspectRatio="none"
      >
        {[max, 0, min].map((value) => (
          <g className="trade-history__guide" key={value}>
            <text x={35} y={y(value) + 4} textAnchor="end">
              {value}
            </text>
            <line x1={42} x2={620} y1={y(value)} y2={y(value)} />
          </g>
        ))}
        {marker >= 0 ? (
          <line
            className="trade-history__marker"
            x1={x(marker)}
            x2={x(marker)}
            y1={14}
            y2={157}
          />
        ) : null}
        {series.map((line) => {
          let previous = false;
          const path = points
            .map((point, index) => {
              const value = line.value(point);
              if (value === null) {
                previous = false;
                return '';
              }
              // A missing comparison also breaks the stock line across skipped runs.
              const command = previous && point.previousId !== null ? 'L' : 'M';
              previous = true;
              return `${command}${x(index)} ${y(value)}`;
            })
            .join(' ');
          return (
            <g className={`trade-history__${line.style}`} key={line.style}>
              <path d={path} />
              {points.map((point, index) => {
                const value = line.value(point);
                return value === null ? null : (
                  <circle
                    cx={x(index)}
                    cy={y(value)}
                    key={point.id}
                    r={point.id === selected ? 4 : 2.3}
                  />
                );
              })}
            </g>
          );
        })}
        {points.map((point, index) =>
          point.coverage === 'complete' || point.captured === null ? null : (
            <circle
              className="trade-history__sample"
              cx={x(index)}
              cy={y(point.captured)}
              key={point.id}
              r={point.id === selected ? 4 : 2.3}
            />
          ),
        )}
      </svg>
      <div className="trade-history__times">
        <span>{points[0] ? formatUtc(points[0].at) : null}</span>
        <span>{points.length > 1 && last ? formatUtc(last.at) : null}</span>
      </div>
      <p>
        Hollow dots show partial samples. Gaps mark unavailable comparisons. The
        negative line shows raw disappearances.
      </p>
    </figure>
  );
}

function AskingPriceHistory({ points }: { points: TradeDashboardPoint[] }) {
  const priced = points.flatMap((point) =>
    point.ask === null ? [] : [{ ...point, ask: point.ask }],
  );
  const first = priced[0];
  if (!first) return <p>No asking prices in this window.</p>;
  const start = Date.parse(first.at);
  const span = Date.parse(priced.at(-1)?.at ?? first.at) - start;
  const asks = priced.map((point) => point.ask);
  const high = Math.max(...asks);
  const low = Math.min(...asks);
  const y = (ask: number) =>
    high === low ? 65 : 18 + ((high - ask) * 94) / (high - low);
  return (
    <figure className="trend-chart">
      <svg
        aria-label="Median asking price per capture"
        className="trend-chart__svg"
        role="img"
        viewBox="0 0 520 130"
      >
        <g className="trend-chart__axis" aria-hidden="true">
          {[...new Set([high, low])].map((ask) => (
            <g key={ask}>
              <line
                className="trend-chart__grid"
                x1={85}
                x2={505}
                y1={y(ask)}
                y2={y(ask)}
              />
              <text x={79} y={y(ask) + 4} textAnchor="end">
                {formatAmount(ask, first.currency)}
              </text>
            </g>
          ))}
        </g>
        {priced.map((point) => (
          <circle
            key={point.id}
            className={
              point.coverage === 'complete'
                ? 'trend-chart__point'
                : 'trend-chart__point trend-chart__point--thin'
            }
            cx={span ? 90 + ((Date.parse(point.at) - start) * 410) / span : 295}
            cy={y(point.ask)}
            r={3.5}
          >
            <title>
              {formatUtc(point.at)} · {formatAmount(point.ask, point.currency)}{' '}
              · {point.coverage} coverage
            </title>
          </circle>
        ))}
      </svg>
      <figcaption className="trend-chart__legend">
        Asks from retained captures. Hollow points indicate limited coverage.
      </figcaption>
    </figure>
  );
}

type Snapshot = Awaited<ReturnType<typeof api.getTradeSnapshot>>['data'];
type Listing = Snapshot['listings'][number];

function observedMods(listing: Listing) {
  const raw = listing.rawListing?.item ?? listing.item;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return [
    'implicitMods',
    'explicitMods',
    'craftedMods',
    'fracturedMods',
    'enchantMods',
  ].flatMap((group) => {
    const mods = raw[group];
    return Array.isArray(mods)
      ? mods.flatMap((mod) => {
          if (typeof mod === 'string') return [mod];
          if (
            mod &&
            typeof mod === 'object' &&
            !Array.isArray(mod) &&
            typeof mod.description === 'string'
          )
            return [mod.description];
          return [];
        })
      : [];
  });
}

function CaptureOffers({ point }: { point: TradeDashboardPoint }) {
  const [filter, setFilter] = useState<'present' | 'missing'>('present');
  const [snapshots, setSnapshots] = useState<{
    current: Snapshot;
    prior: Snapshot | undefined;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.all([
      api.getTradeSnapshot(point.id),
      filter === 'missing' && point.previousId
        ? api.getTradeSnapshot(point.previousId)
        : undefined,
    ])
      .then(([current, prior]) => {
        if (active) {
          setSnapshots({ current: current.data, prior: prior?.data });
          setFailed(false);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [point.id, point.previousId, filter]);

  const unavailable =
    snapshots?.current.rawAvailable === false ||
    (filter === 'missing' && snapshots?.prior?.rawAvailable === false);
  const presentIds = new Set(
    snapshots?.current.listings.map((listing) => listing.externalId),
  );
  const listings =
    filter === 'missing'
      ? snapshots?.prior?.listings.filter(
          (listing) =>
            listing.externalId && !presentIds.has(listing.externalId),
        )
      : snapshots?.current.listings;
  const source = filter === 'missing' ? snapshots?.prior : snapshots?.current;
  return (
    <section
      className="trade-history__offers"
      aria-label="Offers in the selected capture"
    >
      <div
        className="trade-dashboard__ranges"
        role="group"
        aria-label="Offer state"
      >
        <Button
          type="button"
          aria-pressed={filter === 'present'}
          onClick={() => setFilter('present')}
        >
          In capture
        </Button>
        {point.previousId ? (
          <Button
            type="button"
            aria-pressed={filter === 'missing'}
            onClick={() => setFilter('missing')}
          >
            Disappeared
          </Button>
        ) : null}
      </div>
      {failed ? (
        <p role="status">Listing evidence could not be loaded.</p>
      ) : unavailable ? (
        <p>The raw listings for this capture are no longer retained.</p>
      ) : !listings ? (
        <p role="status">Loading listing evidence…</p>
      ) : listings.length ? (
        <div className="trade-history__list">
          {listings.map((listing, index) => {
            const mods = observedMods(listing);
            const itemName = [
              listing.item.name,
              listing.item.baseType,
              listing.item.typeLine,
            ].find((value) => typeof value === 'string' && value.trim());
            const label =
              typeof itemName === 'string' ? itemName : `Listing ${index + 1}`;
            const currency = listing.currency ?? source?.currency;
            return (
              <details key={listing.externalId ?? index}>
                <summary>
                  {label} ·{' '}
                  {listing.price === null
                    ? 'Ask unavailable'
                    : currency === 'divine' || currency === 'chaos'
                      ? formatAmount(listing.price, currency)
                      : `${listing.price} ${currency ?? ''}`}
                </summary>
                <p>
                  {filter === 'missing' && source
                    ? `Last ask seen ${formatUtc(source.capturedAt)}. Absent by ${formatUtc(point.at)}. Sale and payment unknown.`
                    : `Asking price observed ${formatUtc(point.at)}.`}
                </p>
                {mods.length ? (
                  <ul aria-label="Exact observed modifiers">
                    {mods.map((mod, position) => (
                      <li key={position}>{mod}</li>
                    ))}
                  </ul>
                ) : (
                  <p>Exact modifiers are unavailable in the retained source.</p>
                )}
              </details>
            );
          })}
        </div>
      ) : (
        <p>No listings in this selection.</p>
      )}
    </section>
  );
}

export function TradeItemHistory({
  range,
  target,
  league,
  onBack,
}: {
  range: TradeDashboardRange;
  target: string;
  league: string | undefined;
  onBack(): void;
}) {
  const [result, setResult] = useState<{
    target: string;
    response: Awaited<ReturnType<typeof api.getTradeDashboard>>;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState('');
  const [showOffers, setShowOffers] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let active = true;
    setFailed(false);
    api
      .getTradeDashboard(range, league, target)
      .then((response) => {
        if (active) setResult({ target, response });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [range, target, league]);

  const data =
    result?.target === target &&
    result.response.data.range === range &&
    (!league || result.response.data.league === league)
      ? result.response.data
      : null;
  const item = data?.items[0];
  const points = data?.points ?? [];
  const point =
    points.find((capture) => capture.id === selected) ?? points.at(-1);
  const latest = item?.latest;
  const lastPoint = points.at(-1);
  const topShare =
    item?.sellerListings && item.topSellerListings !== null
      ? Math.round((item.topSellerListings * 100) / item.sellerListings)
      : null;
  useEffect(() => {
    if (item?.id) heading.current?.focus();
  }, [item?.id]);

  return (
    <div className="trade-history">
      <Button className="trade-history__back" onClick={onBack} type="button">
        ← Back to tracked items
      </Button>
      {failed ? (
        <StatusPanel tone="warning" title="Item history unavailable" />
      ) : !data ? (
        <StatusPanel tone="info" title="Loading item history" />
      ) : !item ? (
        <p className="trade-dashboard__message">
          This target is unavailable for the selected league.
        </p>
      ) : (
        <>
          <header className="trade-dashboard__heading">
            <div>
              <h3 ref={heading} tabIndex={-1}>
                {item.name}
              </h3>
              <p>
                {item.slot} · {data.league}
              </p>
            </div>
          </header>
          <div className="trade-history__layout">
            <div className="trade-dashboard__card trade-history__body">
              <div className="trade-dashboard__heading">
                <div>
                  <h3>Observed activity</h3>
                  <p>Trade observations in the selected window</p>
                </div>
              </div>
              <dl className="trade-history__metrics">
                <div>
                  <dt>Listings first seen</dt>
                  <dd>{item.firstSeen ?? '—'}</dd>
                  <small>Distinct listing IDs</small>
                </div>
                <div>
                  <dt>Sustained exits</dt>
                  <dd>{item.exits ?? '—'}</dd>
                  <small>{item.settledHours.toFixed(1)}h settled</small>
                </div>
                <div>
                  <dt>Scheduled captures</dt>
                  <dd>{points.length}</dd>
                  <small>Snapshots in this window</small>
                </div>
              </dl>
              {point ? (
                <>
                  <h4>Listing activity per capture</h4>
                  <ListingActivityChart points={points} selected={point.id} />
                  <label className="trade-history__capture">
                    Inspect capture
                    <NativeSelect
                      value={point.id}
                      onChange={(event) => {
                        setSelected(event.target.value);
                        setShowOffers(false);
                      }}
                    >
                      {[...points].reverse().map((capture) => (
                        <option key={capture.id} value={capture.id}>
                          {formatUtc(capture.at)} · {capture.coverage}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  <p aria-live="polite" className="trade-history__reading">
                    {point.captured ?? '—'} captured · {point.firstSeen ?? '—'}{' '}
                    first seen · {point.missing ?? '—'} disappeared ·{' '}
                    {point.sustained ?? '—'} sustained
                  </p>
                  <Button
                    className="trade-dashboard__primary"
                    type="button"
                    aria-expanded={showOffers}
                    onClick={() => setShowOffers((value) => !value)}
                  >
                    {showOffers ? 'Hide listings' : 'Inspect listings and mods'}
                  </Button>
                  <details className="trade-dashboard__method">
                    <summary>Asking-price history</summary>
                    <AskingPriceHistory points={points} />
                  </details>
                  <details className="trade-dashboard__method">
                    <summary>View capture values</summary>
                    <div
                      className="trade-dashboard__table-scroll"
                      tabIndex={0}
                      role="region"
                      aria-label="Scrollable capture values"
                    >
                      <TableSurface>
                        <table className="table__content trade-dashboard__table">
                          <thead className="table__header">
                            <tr className="table__row">
                              <th className="table__column" scope="col">
                                Capture (UTC)
                              </th>
                              <th className="table__column" scope="col">
                                Coverage
                              </th>
                              <th className="table__column" scope="col">
                                In capture
                              </th>
                              <th className="table__column" scope="col">
                                Median ask
                              </th>
                              <th className="table__column" scope="col">
                                First seen
                              </th>
                              <th className="table__column" scope="col">
                                Disappeared
                              </th>
                              <th className="table__column" scope="col">
                                Sustained
                              </th>
                            </tr>
                          </thead>
                          <tbody className="table__body">
                            {[...points].reverse().map((capture) => (
                              <tr className="table__row" key={capture.id}>
                                <th className="table__column" scope="row">
                                  {formatUtc(capture.at)}
                                </th>
                                <td className="table__cell">
                                  {capture.coverage}
                                </td>
                                <td className="table__cell">
                                  {capture.captured ?? '—'}
                                </td>
                                <td className="table__cell">
                                  {capture.ask === null
                                    ? '—'
                                    : formatAmount(
                                        capture.ask,
                                        capture.currency,
                                      )}
                                </td>
                                <td className="table__cell">
                                  {capture.firstSeen ?? '—'}
                                </td>
                                <td className="table__cell">
                                  {capture.missing ?? '—'}
                                </td>
                                <td className="table__cell">
                                  {capture.sustained ?? '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </TableSurface>
                    </div>
                  </details>
                </>
              ) : (
                <p className="trade-dashboard__message">
                  No scheduled captures in this window.
                </p>
              )}
            </div>
            <aside
              className="trade-history__context"
              aria-label="Latest capture and sales evidence"
            >
              <section className="trade-dashboard__card trade-history__latest">
                <h3>Latest capture</h3>
                {latest ? (
                  <>
                    <p>
                      {formatUtc(latest.at)} · {latest.coverage} coverage
                    </p>
                    <dl>
                      <div>
                        <dt>Sample median ask</dt>
                        <dd>
                          {latest.ask === null
                            ? '—'
                            : formatAmount(latest.ask, latest.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt>Sampled listings</dt>
                        <dd>{latest.captured ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>Seller accounts</dt>
                        <dd>{item.sellers ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>Visible ≥48h</dt>
                        <dd>{item.visible48h ?? '—'}</dd>
                      </div>
                    </dl>
                    <div className="trade-history__fact">
                      <h4>
                        Top seller share in sample{' '}
                        {topShare === null ? '—' : topShare + '%'}
                      </h4>
                      {topShare !== null ? (
                        <>
                          <div
                            className="trade-history__meter"
                            aria-hidden="true"
                          >
                            <span style={{ width: topShare + '%' }} />
                          </div>
                          <p>
                            {item.topSellerListings} of {item.sellerListings}{' '}
                            retained offers.
                          </p>
                        </>
                      ) : (
                        <p>Seller breakdown unavailable.</p>
                      )}
                    </div>
                    <div className="trade-history__fact">
                      <h4>
                        {lastPoint?.missing != null &&
                        lastPoint.id === latest.id
                          ? lastPoint.missing + ' missing from search'
                          : 'Latest comparison unavailable'}
                      </h4>
                      <p>
                        Disappearances are measured between compatible captures.
                        Outcome unknown.
                      </p>
                    </div>
                  </>
                ) : (
                  <p>No scheduled capture is available.</p>
                )}
              </section>
              <section className="trade-dashboard__card trade-history__sales">
                <div>
                  <h4>Confirmed sales</h4>
                  <span className="trade-dashboard__badge">Unavailable</span>
                </div>
                <p>
                  Sold counts, paid prices and unique buyers require verified
                  transactions.
                </p>
              </section>
            </aside>
          </div>
          {showOffers && point ? (
            <div className="trade-dashboard__card trade-history__offer-card">
              <h3>Inspect offers</h3>
              <p>Open a listing to see its observed ask and exact mods.</p>
              <CaptureOffers key={point.id} point={point} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
