import type {
  ScheduledTradeTrendResponse,
  TrendRange,
} from '@poe-worksmith/contracts';
import { useEffect, useState } from 'react';

import { createApiClient } from './apiClient.js';
import { StatusPanel } from './components.js';
import { formatAmount, formatUtc } from './PriceTrendChart.js';

const api = createApiClient();
const refreshMs = 60_000;

type Series = NonNullable<ScheduledTradeTrendResponse['data']['series']>;

function TradeChart({ series, name }: { series: Series; name: string }) {
  const priced = series.points.flatMap((point) =>
    point.median === null ? [] : [{ ...point, median: point.median }],
  );
  if (!priced.length) return <p>No asking prices in the selected window.</p>;

  const first = Date.parse(priced[0]!.capturedAt);
  const last = Date.parse(priced.at(-1)!.capturedAt);
  const values = priced.map((point) => point.median);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const priceLabel = (value: number) => formatAmount(value, series.currency);
  const y = (value: number) =>
    max === min ? 78 : 132 - ((value - min) / (max - min)) * 108;

  return (
    <figure className="trend-chart">
      <svg
        aria-label={`${name}: median asking prices, ${priced.length} priced snapshots`}
        className="trend-chart__svg"
        role="img"
        viewBox="0 0 520 166"
      >
        <g className="trend-chart__axis" aria-hidden="true">
          {[...new Set([max, (max + min) / 2, min])].map((value) => (
            <g key={value}>
              <line
                className="trend-chart__grid"
                x1={78}
                x2={503}
                y1={y(value)}
                y2={y(value)}
              />
              <text x={73} y={y(value) + 4} textAnchor="end">
                {priceLabel(value)}
              </text>
            </g>
          ))}
          <text x={78} y={155}>
            {formatUtc(priced[0]!.capturedAt)}
          </text>
          {first !== last ? (
            <text x={503} y={155} textAnchor="end">
              {formatUtc(priced.at(-1)!.capturedAt)}
            </text>
          ) : null}
        </g>
        {priced.map((point) => (
          <circle
            className={
              point.coverage === 'complete' && point.count > 1
                ? 'trend-chart__point'
                : 'trend-chart__point trend-chart__point--thin'
            }
            cx={
              last === first
                ? 290
                : 83 +
                  ((Date.parse(point.capturedAt) - first) / (last - first)) *
                    415
            }
            cy={y(point.median)}
            data-snapshot-id={point.id}
            key={point.id}
            r={4}
          >
            <title>{`${formatUtc(point.capturedAt)} · ${priceLabel(point.median)} · ${point.count} listings · ${point.coverage ?? 'unknown'} coverage`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="trend-chart__legend">
        <span className="trend-chart__key trend-chart__key--ask">
          Median ask per snapshot
        </span>
        <span className="trend-chart__key trend-chart__key--thin">
          Partial coverage or single listing
        </span>
      </figcaption>
      <details className="trend-chart__data">
        <summary>Latest 20 snapshots</summary>
        <div className="trend-chart__table-wrap">
          <table>
            <caption className="visually-hidden">
              Scheduled Trade snapshots for {name}
            </caption>
            <thead>
              <tr>
                <th scope="col">Collected (UTC)</th>
                <th scope="col">Median ask</th>
                <th scope="col">Listings</th>
                <th scope="col">Coverage</th>
              </tr>
            </thead>
            <tbody>
              {series.points
                .slice(-20)
                .reverse()
                .map((point) => (
                  <tr key={point.id}>
                    <th scope="row">
                      <time dateTime={point.capturedAt}>
                        {formatUtc(point.capturedAt)}
                      </time>
                    </th>
                    <td>
                      {point.median === null ? '—' : priceLabel(point.median)}
                    </td>
                    <td>{point.count}</td>
                    <td>{point.coverage ?? 'unknown'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

export function ScheduledTradeTrends({ range }: { range: TrendRange }) {
  const [target, setTarget] = useState('');
  const [response, setResponse] = useState<
    ScheduledTradeTrendResponse['data'] | null
  >(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let selected = target;
    async function refresh() {
      try {
        const { data } = await api.getScheduledTradeTrend(range, selected);
        if (!active) return;
        selected ||= data.series?.targetId ?? '';
        setResponse(data);
        setFailed(false);
      } catch {
        if (active) setFailed(true);
      } finally {
        if (active) timer = setTimeout(() => void refresh(), refreshMs);
      }
    }
    setFailed(false);
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [range, target]);

  const data = response?.range === range ? response : null;
  const series =
    data?.series && (!target || data.series.targetId === target)
      ? data.series
      : null;
  const name =
    data?.targets.find(({ id }) => id === series?.targetId)?.name ?? '';
  const latest = series?.points.at(-1);

  return (
    <section
      className="detail-section"
      aria-labelledby="scheduled-trade-heading"
    >
      <h2 id="scheduled-trade-heading">Scheduled Trade observations</h2>
      <p>
        Median asking prices from the Trade collector. Each dot is one priced
        snapshot. Sales volume is unknown.
      </p>
      {data?.targets.length ? (
        <label className="market-trends__picker market-trends__picker--trade">
          Trade target
          <select
            value={target || series?.targetId || ''}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="" disabled>
              Select a Trade target
            </option>
            {data.targets.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {failed ? (
        <StatusPanel
          tone="warning"
          title="Could not refresh Trade observations"
        />
      ) : null}
      {series && latest ? (
        <>
          <p>
            {series.league} · {series.patch} · latest collection{' '}
            <time dateTime={latest.capturedAt}>
              {formatUtc(latest.capturedAt)}
            </time>
            {' · '}
            {latest.count} listings · {latest.coverage ?? 'unknown'} coverage
          </p>
          <TradeChart name={name} series={series} />
        </>
      ) : failed ? null : (
        <p>
          {!data ||
          (target &&
            data.targets.some(({ id }) => id === target) &&
            data.series)
            ? 'Loading Trade observations…'
            : 'No scheduled Trade observations in the selected window for this selection.'}
        </p>
      )}
    </section>
  );
}
