import { TableSurface } from './ui.js';
import type {
  Price,
  RecipeTrend,
  TrendBucket,
  TrendSummary,
} from '@poe-worksmith/contracts';
import { useEffect, useId, useRef, useState } from 'react';

import { Money, economicClass } from './components.js';

const height = 220;
const pad = { top: 14, right: 14, bottom: 26, left: 64 };
const plotHeight = height - pad.top - pad.bottom;

const amountFormat = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
});
const dateTime = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  hourCycle: 'h23',
  timeZone: 'UTC',
});
const shortDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const unit = { chaos: 'c', divine: 'div' } as const;

export function formatAmount(amount: number, currency: Price['currency']) {
  return `${amountFormat.format(amount)} ${unit[currency]}`;
}

export function formatUtc(iso: string) {
  return `${dateTime.format(new Date(iso))} UTC`;
}

export function formatPercent(value: number) {
  return `${value > 0 ? '+' : ''}${amountFormat.format(value)}%`;
}

/**
 * Splits buckets into runs of adjacent buckets. A missing bucket ends a run,
 * so the chart never draws a line across unobserved time.
 */
export function contiguousRuns<T extends { start: string }>(
  buckets: readonly T[],
  bucketSeconds: number,
): T[][] {
  const runs: T[][] = [];
  for (const bucket of buckets) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    if (
      run &&
      previous &&
      Date.parse(bucket.start) - Date.parse(previous.start) ===
        bucketSeconds * 1000
    )
      run.push(bucket);
    else runs.push([bucket]);
  }
  return runs;
}

/** Plain-language description used for the SVG desc and the visible summary. */
export function describeTrend(trend: RecipeTrend) {
  const summary = trend.summary;
  if (!summary)
    return trend.state === 'unavailable'
      ? 'Price history is unavailable until the current league is resolved.'
      : 'No independent ask observations have been recorded for this recipe yet.';
  const latest = `Latest cheapest ask ${formatAmount(summary.latestAsk, summary.currency)}, observed ${formatUtc(summary.latestObservedAt)}.`;
  if (summary.windowObservations === 0)
    return `No observations in the selected window. ${latest}`;
  const observed = `${summary.windowObservations} independent ${summary.windowObservations === 1 ? 'observation' : 'observations'} in this window.`;
  if (!summary.change)
    return `${observed} Only one observation point, so no trend is shown. ${latest}`;
  const change = summary.change;
  return `${observed} Ask moved from ${formatAmount(change.from, summary.currency)} to ${formatAmount(change.to, summary.currency)}${change.percent === null ? '' : ` (${formatPercent(change.percent)})`} between ${formatUtc(change.fromObservedAt)} and ${formatUtc(change.toObservedAt)}. ${latest}`;
}

/** Fit the recorded span; never invent points in the unobserved part of a range. */
export function observedWindow(trend: RecipeTrend) {
  const starts = trend.buckets.map((bucket) => Date.parse(bucket.start));
  const start = Math.max(
    Date.parse(trend.windowStart),
    starts.length ? Math.min(...starts) : Date.parse(trend.windowStart),
  );
  const end = Math.max(
    start + 1,
    Math.min(
      Date.parse(trend.windowEnd),
      starts.length
        ? Math.max(...starts) + trend.bucketSeconds * 1000
        : Date.parse(trend.windowEnd),
    ),
  );
  return { start, end };
}

function scale(trend: RecipeTrend, width: number) {
  const plotWidth = width - pad.left - pad.right;
  const { start, end } = observedWindow(trend);
  const values = trend.buckets.flatMap((bucket) => [
    bucket.low,
    bucket.high,
    ...(bucket.craftCost === null ? [] : [bucket.craftCost]),
  ]);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const spread = rawMax - rawMin;
  const margin = spread > 0 ? spread * 0.08 : Math.max(rawMax * 0.05, 1);
  const min = Math.max(0, rawMin - margin);
  const max = rawMax + margin;
  return {
    min,
    max,
    x(bucket: TrendBucket) {
      const middle =
        Date.parse(bucket.start) + (trend.bucketSeconds * 1000) / 2;
      const time = Math.min(Math.max(middle, start), end);
      return pad.left + ((time - start) / (end - start)) * plotWidth;
    },
    y(value: number) {
      return pad.top + (1 - (value - min) / (max - min)) * plotHeight;
    },
  };
}

function path(points: { x: number; y: number }[]) {
  return points
    .map(
      ({ x, y }, index) =>
        `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`,
    )
    .join(' ');
}

export function PriceTrendChart({ trend }: { trend: RecipeTrend }) {
  const container = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    if (!container.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [trend.recipeId, trend.buckets.length]);
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const description = describeTrend(trend);
  const summary = trend.summary;
  if (!summary || trend.buckets.length === 0)
    return (
      <div className="trend-chart trend-chart--empty">
        <p>{description}</p>
      </div>
    );
  const currency = summary.currency;
  const s = scale(trend, width);
  const window = observedWindow(trend);
  const axisDate =
    window.end - window.start <= 48 * 3600_000
      ? new Intl.DateTimeFormat('en-GB', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
          timeZone: 'UTC',
        })
      : shortDate;
  const runs = contiguousRuns(trend.buckets, trend.bucketSeconds);
  const costRuns = runs.flatMap((run) =>
    contiguousRuns(
      run.filter((bucket) => bucket.craftCost !== null),
      trend.bucketSeconds,
    ),
  );
  return (
    <figure className="trend-chart" ref={container}>
      <svg
        aria-labelledby={`${titleId} ${descId}`}
        className="trend-chart__svg"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        <title id={titleId}>
          {`${trend.title}: cheapest ask history (${trend.range})`}
        </title>
        <desc id={descId}>{description}</desc>
        <g className="trend-chart__axis" aria-hidden="true">
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={height - pad.bottom}
            y2={height - pad.bottom}
          />
          {[s.max, (s.max + s.min) / 2, s.min].map((value) => (
            <g key={value}>
              <line
                className="trend-chart__grid"
                x1={pad.left}
                x2={width - pad.right}
                y1={s.y(value)}
                y2={s.y(value)}
              />
              <text x={pad.left - 8} y={s.y(value) + 4} textAnchor="end">
                {new Intl.NumberFormat('en-GB', {
                  maximumSignificantDigits: 3,
                  notation: Math.abs(value) >= 10000 ? 'compact' : 'standard',
                }).format(value)}{' '}
                {unit[currency]}
              </text>
            </g>
          ))}
          <text x={pad.left} y={height - 8}>
            {axisDate.format(new Date(window.start))}
          </text>
          <text x={width - pad.right} y={height - 8} textAnchor="end">
            {axisDate.format(new Date(window.end))}
          </text>
        </g>
        <g aria-hidden="true">
          {trend.buckets
            .filter((bucket) => bucket.high > bucket.low)
            .map((bucket) => (
              <line
                className="trend-chart__range"
                key={`range-${bucket.start}`}
                x1={s.x(bucket)}
                x2={s.x(bucket)}
                y1={s.y(bucket.high)}
                y2={s.y(bucket.low)}
              />
            ))}
          {costRuns
            .filter((run) => run.length > 1)
            .map((run) => (
              <path
                className="trend-chart__cost"
                d={path(run.map((b) => ({ x: s.x(b), y: s.y(b.craftCost!) })))}
                key={`cost-${run[0]!.start}`}
              />
            ))}
          {costRuns
            .filter((run) => run.length === 1)
            .map(([bucket]) => (
              <circle
                className="trend-chart__cost-point"
                cx={s.x(bucket!)}
                cy={s.y(bucket!.craftCost!)}
                key={`cost-point-${bucket!.start}`}
                r={3}
              />
            ))}
          {runs
            .filter((run) => run.length > 1)
            .map((run) => (
              <path
                className="trend-chart__ask"
                d={path(run.map((b) => ({ x: s.x(b), y: s.y(b.close) })))}
                key={`ask-${run[0]!.start}`}
              />
            ))}
          {trend.buckets.map((bucket) => (
            <circle
              className={
                (bucket.minComparableSellers ?? 0) < 2
                  ? 'trend-chart__point trend-chart__point--thin'
                  : 'trend-chart__point'
              }
              cx={s.x(bucket)}
              cy={s.y(bucket.close)}
              key={`point-${bucket.start}`}
              r={3.5}
            />
          ))}
        </g>
      </svg>
      <figcaption className="trend-chart__legend">
        <span>Recorded span within {trend.range} · UTC</span>
        <span className="trend-chart__key trend-chart__key--ask">
          Cheapest ask (close)
        </span>
        {trend.buckets.some((bucket) => bucket.craftCost !== null) ? (
          <span className="trend-chart__key trend-chart__key--cost">
            Recorded craft cost
          </span>
        ) : null}
        <span className="trend-chart__key trend-chart__key--thin">
          Thin / unknown seller depth
        </span>
        <span>Gaps mean no observation · asks, not sales</span>
      </figcaption>
      <details className="trend-chart__data">
        <summary>Data table</summary>
        <div className="trend-chart__table-wrap">
          <TableSurface>
            <table className="table__content">
              <caption className="visually-hidden">
                {`${trend.title} ask history by ${trend.bucketSeconds >= 86400 ? 'UTC day' : 'UTC time bucket'}`}
              </caption>
              <thead className="table__header">
                <tr className="table__row">
                  <th className="table__column" scope="col">
                    Bucket (UTC)
                  </th>
                  <th className="table__column" scope="col">
                    Open
                  </th>
                  <th className="table__column" scope="col">
                    High
                  </th>
                  <th className="table__column" scope="col">
                    Low
                  </th>
                  <th className="table__column" scope="col">
                    Close
                  </th>
                  <th className="table__column" scope="col">
                    Craft cost
                  </th>
                  <th className="table__column" scope="col">
                    Observations
                  </th>
                  <th className="table__column" scope="col">
                    Sellers (min/last)
                  </th>
                </tr>
              </thead>
              <tbody className="table__body">
                {trend.buckets.map((bucket) => (
                  <tr className="table__row" key={bucket.start}>
                    <th className="table__column" scope="row">
                      <time dateTime={bucket.start}>
                        {formatUtc(bucket.start)}
                      </time>
                    </th>
                    <td className="table__cell">
                      {formatAmount(bucket.open, currency)}
                    </td>
                    <td className="table__cell">
                      {formatAmount(bucket.high, currency)}
                    </td>
                    <td className="table__cell">
                      {formatAmount(bucket.low, currency)}
                    </td>
                    <td className="table__cell">
                      {formatAmount(bucket.close, currency)}
                    </td>
                    <td className="table__cell">
                      {bucket.craftCost === null
                        ? '—'
                        : formatAmount(bucket.craftCost, currency)}
                    </td>
                    <td className="table__cell">{bucket.observations}</td>
                    <td className="table__cell">
                      {bucket.minComparableSellers ?? '?'}/
                      {bucket.lastComparableSellers ?? '?'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableSurface>
        </div>
      </details>
    </figure>
  );
}

const oldObservationMs = 24 * 3_600_000;

/** Current ask/cost, observed change and evidence quality for one series. */
export function TrendFacts({
  summary,
  now = Date.now(),
}: {
  summary: TrendSummary | null;
  now?: number;
}) {
  if (!summary) return null;
  const old = now - Date.parse(summary.latestObservedAt) > oldObservationMs;
  const sellers = summary.latestComparableSellers;
  return (
    <dl className="trend-facts">
      <div>
        <dt>Last recorded ask</dt>
        <dd>
          <Money
            price={{ amount: summary.latestAsk, currency: summary.currency }}
          />
        </dd>
      </div>
      <div>
        <dt>Recorded craft cost</dt>
        <dd>
          {summary.latestCraftCost === null ? (
            'Not recorded'
          ) : (
            <Money
              price={{
                amount: summary.latestCraftCost,
                currency: summary.currency,
              }}
            />
          )}
          {summary.latestCraftCostObservedAt ? (
            <small className="trend-facts__time">
              <time dateTime={summary.latestCraftCostObservedAt}>
                {formatUtc(summary.latestCraftCostObservedAt)}
              </time>
            </small>
          ) : null}
        </dd>
      </div>
      <div>
        <dt>Change (observed window)</dt>
        <dd
          className={
            summary.change ? economicClass(summary.change.absolute) : undefined
          }
        >
          {summary.change
            ? summary.change.percent === null
              ? formatAmount(summary.change.absolute, summary.currency)
              : formatPercent(summary.change.percent)
            : 'Insufficient history'}
        </dd>
      </div>
      <div>
        <dt>Observations</dt>
        <dd>{summary.windowObservations}</dd>
      </div>
      <div>
        <dt>Sellers (latest)</dt>
        <dd>
          {sellers === null ? 'Unknown' : sellers}
          {sellers !== null && sellers < 2 ? ' · Ask only, no ROI' : ''}
        </dd>
      </div>
      <div>
        <dt>Last source time</dt>
        <dd>
          <time dateTime={summary.latestObservedAt}>
            {formatUtc(summary.latestObservedAt)}
          </time>
          {old ? ' · Old observation' : ''}
          {summary.latestCoverage && summary.latestCoverage !== 'complete'
            ? ` · ${summary.latestCoverage} coverage`
            : ''}
        </dd>
      </div>
      {summary.excludedCurrencies.length ? (
        <div>
          <dt>Not mixed</dt>
          <dd>
            Also observed in {summary.excludedCurrencies.join(', ')}; not mixed
            into this series.
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
