import type {
  TrendOverviewEntry,
  TrendSummary,
} from '@poe-worksmith/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { App } from './App.js';
import { filterTrendEntries, sortTrendEntries } from './MarketTrendsPage.js';

function entry(
  title: string,
  summary: Partial<TrendSummary> | null,
): TrendOverviewEntry {
  return {
    recipeId: title.toLowerCase(),
    title,
    category: 'jewel',
    summary: summary && {
      currency: 'chaos',
      latestAsk: 10,
      latestObservedAt: '2026-11-03T00:00:00.000Z',
      latestComparableSellers: 3,
      latestCoverage: 'complete',
      latestCraftCost: null,
      latestCraftCostObservedAt: null,
      windowObservations: 2,
      windowFirstObservedAt: null,
      windowLastObservedAt: null,
      change: null,
      excludedCurrencies: [],
      ...summary,
    },
  };
}

const change = (percent: number | null) => ({
  from: 1,
  fromObservedAt: '2026-11-01T00:00:00.000Z',
  to: 2,
  toObservedAt: '2026-11-02T00:00:00.000Z',
  absolute: 1,
  percent,
});

describe('market trend dashboard', () => {
  const entries = [
    entry('Alpha', { latestAsk: 5, currency: 'divine', change: change(-3) }),
    entry('Bravo', { latestAsk: 500, change: change(12) }),
    entry('Charlie', null),
    entry('Delta', { latestAsk: 50, change: null }),
    entry('Echo', { latestAsk: 2, currency: 'divine', change: change(40) }),
  ];

  it('sorts by percent change, putting insufficient history last', () => {
    expect(sortTrendEntries(entries, 'change').map((e) => e.title)).toEqual([
      'Echo',
      'Bravo',
      'Alpha',
      'Charlie',
      'Delta',
    ]);
  });

  it('compares latest asks only within one currency', () => {
    expect(sortTrendEntries(entries, 'ask').map((e) => e.title)).toEqual([
      'Bravo',
      'Delta',
      'Alpha',
      'Echo',
      'Charlie',
    ]);
  });

  it('filters by title, id or category', () => {
    expect(filterTrendEntries(entries, 'ech').map((e) => e.title)).toEqual([
      'Echo',
    ]);
    expect(filterTrendEntries(entries, '  ')).toHaveLength(5);
  });

  it('is reachable from the catalog through primary navigation', () => {
    const catalog = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(catalog).toMatch(/<nav aria-label="Primary"/);
    expect(catalog).toContain('href="/market"');
    const market = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/market?range=30d']}>
        <App />
      </MemoryRouter>,
    );
    expect(market).toContain('Market trends');
    expect(market).toContain('Loading market trends');
    expect(market).toMatch(
      /aria-current="page"[^>]*>[^]*?<span>Market trends<\/span>[^]*?<\/a>/,
    );
  });
});
