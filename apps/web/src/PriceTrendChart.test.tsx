import type { RecipeTrend, TrendBucket } from '@poe-worksmith/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  PriceTrendChart,
  TrendFacts,
  contiguousRuns,
  describeTrend,
} from './PriceTrendChart.js';

const hour = 3_600_000;
const origin = Date.parse('2026-11-02T00:00:00.000Z');
const iso = (hours: number) => new Date(origin + hours * hour).toISOString();

function bucket(
  hours: number,
  close: number,
  extra: Partial<TrendBucket> = {},
) {
  return {
    start: iso(hours),
    firstObservedAt: iso(hours),
    lastObservedAt: iso(hours),
    open: close,
    high: close,
    low: close,
    close,
    observations: 1,
    craftCost: null,
    craftCostObservedAt: null,
    minComparableSellers: 3,
    lastComparableSellers: 3,
    ...extra,
  } satisfies TrendBucket;
}

function trend(
  buckets: TrendBucket[],
  change = buckets.length > 1,
): RecipeTrend {
  const first = buckets[0];
  const last = buckets.at(-1);
  return {
    state: buckets.length ? 'available' : 'empty',
    range: '24h',
    bucketSeconds: 3600,
    windowStart: iso(0),
    windowEnd: iso(24),
    league: { id: 'league', name: 'League' },
    priceBasis: 'asking',
    salesVolume: 'unknown',
    recipeId: 'recipe',
    title: 'Fixture Jewel',
    summary:
      first && last
        ? {
            currency: 'chaos',
            latestAsk: last.close,
            latestObservedAt: last.lastObservedAt,
            latestComparableSellers: last.lastComparableSellers,
            latestCoverage: 'complete',
            latestCraftCost: null,
            latestCraftCostObservedAt: null,
            windowObservations: buckets.reduce((n, b) => n + b.observations, 0),
            windowFirstObservedAt: first.firstObservedAt,
            windowLastObservedAt: last.lastObservedAt,
            change: change
              ? {
                  from: first.open,
                  fromObservedAt: first.firstObservedAt,
                  to: last.close,
                  toObservedAt: last.lastObservedAt,
                  absolute: last.close - first.open,
                  percent: ((last.close - first.open) / first.open) * 100,
                }
              : null,
            excludedCurrencies: [],
          }
        : null,
    buckets,
  };
}

const count = (html: string, pattern: RegExp) =>
  html.match(new RegExp(pattern, 'g'))?.length ?? 0;

describe('price trend chart', () => {
  it('labels a historical craft estimate with its own observation time', () => {
    const summary = trend([bucket(10, 100)]).summary!;
    const html = renderToStaticMarkup(
      <TrendFacts
        summary={{
          ...summary,
          latestCraftCost: 42,
          latestCraftCostObservedAt: iso(2),
        }}
      />,
    );
    expect(html).toContain('Recorded craft cost');
    expect(html).toContain(iso(2));
  });

  it('splits runs at missing buckets', () => {
    const runs = contiguousRuns(
      [bucket(1, 1), bucket(2, 2), bucket(5, 3), bucket(6, 4), bucket(9, 5)],
      3600,
    );
    expect(runs.map((run) => run.length)).toEqual([2, 2, 1]);
  });

  it('renders an accessible SVG with gaps as separate lines and no zero-fill', () => {
    const html = renderToStaticMarkup(
      <PriceTrendChart
        trend={trend([
          bucket(1, 100),
          bucket(2, 110, { high: 130, low: 95 }),
          bucket(6, 90),
          bucket(7, 95),
        ])}
      />,
    );
    expect(html).toContain('role="img"');
    expect(html).toMatch(/<svg[^>]*aria-labelledby="[^"]+-title [^"]+-desc"/);
    expect(html).toMatch(
      /<title id="[^"]+-title">Fixture Jewel: cheapest ask history \(24h\)<\/title>/,
    );
    expect(html).toMatch(/<desc[^>]*>4 independent observations/);
    expect(count(html, /class="trend-chart__ask"/)).toBe(2);
    expect(count(html, /class="trend-chart__point"/)).toBe(4);
    expect(count(html, /class="trend-chart__range"/)).toBe(1);
    expect(html).not.toContain('>0 c<');
    expect(html).toContain('<table>');
    expect(count(html, /<tr>/)).toBe(5);
    expect(html).toContain('asks, not sales');
  });

  it('draws a single observation as a dot without a trend', () => {
    const single = trend([bucket(3, 50)], false);
    const html = renderToStaticMarkup(<PriceTrendChart trend={single} />);
    expect(count(html, /class="trend-chart__ask"/)).toBe(0);
    expect(count(html, /class="trend-chart__point"/)).toBe(1);
    expect(describeTrend(single)).toContain(
      'Only one observation point, so no trend is shown.',
    );
    expect(
      renderToStaticMarkup(<TrendFacts summary={single.summary} />),
    ).toContain('Insufficient history');
  });

  it('keeps a flat series finite and shows zero change', () => {
    const flat = trend([bucket(1, 40), bucket(2, 40), bucket(3, 40)]);
    const html = renderToStaticMarkup(<PriceTrendChart trend={flat} />);
    expect(html).not.toContain('NaN');
    expect(html).toContain('40 c');
    expect(
      renderToStaticMarkup(
        <TrendFacts now={Date.parse(iso(4))} summary={flat.summary} />,
      ),
    ).toMatch(/economic-unknown">\+?0%/);
  });

  it('marks thin samples and draws craft cost separately from asks', () => {
    const html = renderToStaticMarkup(
      <PriceTrendChart
        trend={trend([
          bucket(1, 100, { craftCost: 40, craftCostObservedAt: iso(1) }),
          bucket(2, 120, {
            craftCost: 42,
            craftCostObservedAt: iso(2),
            minComparableSellers: 1,
          }),
        ])}
      />,
    );
    expect(count(html, /trend-chart__point--thin/)).toBe(1);
    expect(count(html, /class="trend-chart__cost"/)).toBe(1);
    expect(html).toContain('Recorded craft cost');
  });

  it('explains empty and old history without drawing a chart', () => {
    const empty = trend([]);
    expect(
      renderToStaticMarkup(<PriceTrendChart trend={empty} />),
    ).not.toContain('<svg');
    expect(describeTrend(empty)).toContain('No independent ask observations');
    const old = trend([bucket(1, 10)], false);
    expect(
      renderToStaticMarkup(
        <TrendFacts now={Date.parse(iso(72))} summary={old.summary} />,
      ),
    ).toContain('Old observation');
  });
});
