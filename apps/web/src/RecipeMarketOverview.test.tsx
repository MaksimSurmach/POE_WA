import type { MarketReadiness } from '@poe-worksmith/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { catalogFixtures } from './mocks/catalog.js';
import { marketRecipePoint } from './RecipeMarketOverview.js';
import { TurnoverMap } from './TurnoverMap.js';

const readiness: MarketReadiness = {
  level: 'price-observed',
  capturedAt: '2026-11-11T10:00:00Z',
  fresh: true,
  coverage: 'partial',
  currentListings: 5,
  currentSellers: 4,
  comparableSellers: 4,
  currentAskRange: {
    min: { amount: 42, currency: 'chaos' },
    max: { amount: 55, currency: 'chaos' },
  },
  staleFloorCount: 0,
  comparableAsks: true,
  costVerified: false,
  saleEligible: false,
  activityMeasurable: false,
  last24h: {
    complete: 1,
    partial: 1,
    failed: 0,
    failuresTrackedSince: null,
    spanMinutes: 0,
    completeSpanMinutes: 0,
    largestGapMinutes: null,
    overdueIntervals: null,
    sellers: 4,
    listings: 5,
    repriced: null,
    inferredExits: 0,
    exitSellers: null,
    uncertainExits: null,
    relisted: null,
    askRange: null,
  },
};
const entry = { ...catalogFixtures[0]!, readiness };

it('includes a fresh collector ask even when cost and profit are unverified', () => {
  const point = marketRecipePoint(entry);
  expect(point.price).toEqual({ amount: 42, currency: 'chaos' });
  expect(point.exits).toBeNull();
});

it('preserves measured zero but never turns unknown or stale activity into zero', () => {
  expect(
    marketRecipePoint({
      ...entry,
      readiness: { ...readiness, activityMeasurable: true },
    }).exits,
  ).toBe(0);
  expect(
    marketRecipePoint({
      ...entry,
      readiness: { ...readiness, fresh: false, activityMeasurable: true },
    }),
  ).toMatchObject({ price: null, exits: null });
  expect(
    marketRecipePoint({
      ...entry,
      readiness: { ...readiness, currentAskRange: null },
    }).price,
  ).toBeNull();
});

it('plots multiple recipes and keeps unknown activity outside the numerical axis', () => {
  const html = renderToStaticMarkup(
    <TurnoverMap
      items={[
        { id: 'measured', name: 'Measured zero', price: 42, activity: 0 },
        {
          id: 'unknown',
          name: 'Needs more captures',
          price: 42,
          activity: null,
        },
        { id: 'active', name: 'Observed exits', price: 84, activity: 3 },
      ]}
      currency="chaos"
      activityDescription="inferred exits"
      selected={null}
      onSelect={() => {}}
    />,
  );
  expect(html.match(/<button/g)).toHaveLength(3);
  expect(html).toContain('0 inferred exits');
  expect(html).toContain('activity not measurable');
  expect(html).toContain('bottom:-30%');
  expect(html).not.toContain('NaN');
  expect(html).not.toContain('Infinity');
});

it('groups coincident recipes at their exact value without jittering measured zero upward', () => {
  const html = renderToStaticMarkup(
    <TurnoverMap
      items={[
        { id: 'a', name: 'Recipe A', price: 42, activity: 0 },
        { id: 'b', name: 'Recipe B', price: 42, activity: 0 },
      ]}
      currency="chaos"
      selected="b"
      onSelect={() => {}}
    />,
  );
  expect(html).toContain('2 recipes, 42 chaos');
  expect(html).toContain('bottom:0%');
  expect(html).toContain('popover="auto"');
  expect(html).toContain('Recipe A');
  expect(html).toContain('Recipe B');
  expect(html).toContain('aria-pressed="true"');
});
