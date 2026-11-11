import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CatalogTable } from './CatalogTable.js';
import { catalogFixtures } from './mocks/catalog.js';
import { defaultCatalogFilters } from './catalog.js';

describe('catalog table', () => {
  it.each([true, false])(
    'shows only fresh observed sample asks without inventing profit (fresh=%s)',
    (fresh) => {
      const entry = catalogFixtures[0]!;
      const readiness = {
        level: 'price-observed' as const,
        capturedAt: '2026-11-11T10:00:00.000Z',
        fresh,
        coverage: 'partial' as const,
        currentListings: 8,
        currentSellers: 6,
        comparableSellers: null,
        currentAskRange: {
          min: { amount: 12345, currency: 'chaos' as const },
          max: { amount: 54321, currency: 'chaos' as const },
        },
        staleFloorCount: 0,
        comparableAsks: false,
        costVerified: false,
        saleEligible: false,
        activityMeasurable: false,
        last24h: {
          complete: 0,
          partial: 1,
          failed: 0,
          failuresTrackedSince: null,
          spanMinutes: 0,
          completeSpanMinutes: 0,
          largestGapMinutes: null,
          overdueIntervals: null,
          sellers: 6,
          listings: 8,
          repriced: 0,
          inferredExits: null,
          exitSellers: null,
          uncertainExits: 0,
          relisted: 0,
          askRange: null,
        },
      };
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <CatalogTable
            entries={[
              {
                ...entry,
                snapshot: null,
                readiness,
                evaluation: {
                  ...entry.evaluation,
                  status: 'loading',
                  source: undefined,
                  expectedCraftCost: null,
                  estimatedSalePrice: null,
                  profit: null,
                  marginPercent: null,
                },
              },
            ]}
            filters={defaultCatalogFilters}
            onSort={() => {}}
          />
        </MemoryRouter>,
      );
      expect(html.includes('12,345 c')).toBe(fresh);
      expect(html.includes('Sample ask · not a sale')).toBe(fresh);
      expect(html).not.toContain('data-label="Profit"');
      expect(html).not.toContain('data-label="ROI"');
    },
  );

  it('shows the price source when raw listings are unavailable', () => {
    const entry = {
      ...catalogFixtures[0]!,
      snapshot: null,
      evaluation: {
        ...catalogFixtures[0]!.evaluation,
        profit: null,
        marginPercent: null,
        source: {
          capturedAt: '2026-11-04T10:00:00.000Z',
          comparableSellers: 1,
          coverage: 'complete' as const,
        },
      },
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CatalogTable
          entries={[entry]}
          filters={defaultCatalogFilters}
          onSort={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('1 seller');
    expect(html).toContain('Single ask · ROI withheld');
    expect(html).toContain('2026-11-04T10:00:00.000Z');
    expect(html).not.toContain('Source details unavailable');
  });
  it('shows the two one-item budgets below the mean cost', () => {
    const entry = catalogFixtures[0]!;
    const withBudget = {
      ...entry,
      evaluation: {
        ...entry.evaluation,
        expectedCraftCost: { amount: 120, currency: 'chaos' as const },
        budget: {
          p50: { amount: 110, currency: 'chaos' as const },
          p90: { amount: 140, currency: 'chaos' as const },
        },
      },
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CatalogTable
          entries={[withBudget]}
          filters={defaultCatalogFilters}
          onSort={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).toMatch(
      /<td[^>]*data-label="Expected cost"[^>]*>[^]*120 c[^]*budget for one[^]*p50[^]*110 c[^]*p90[^]*140 c[^]*<\/td>/,
    );
  });

  it('shows the grade beside profit and reasons in market evidence', () => {
    const entry = catalogFixtures[0]!;
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CatalogTable
          entries={[
            {
              ...entry,
              evaluation: {
                ...entry.evaluation,
                grade: 'C',
                gradeReasons: ['1 seller', 'outlier ask ignored'],
                source: {
                  capturedAt: '2026-11-04T10:00:00.000Z',
                  comparableSellers: 1,
                  coverage: 'complete',
                },
              },
            },
          ]}
          filters={defaultCatalogFilters}
          onSort={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('title="1 seller · outlier ask ignored"');
    expect(html).toContain('>C</');
    expect(html).toContain('>1 seller · outlier ask ignored</');
    expect(html).not.toContain('ROI withheld');
  });

  it('omits the withholding warning when an unexpired stale fallback still shows profit', () => {
    const entry = catalogFixtures[0]!;
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CatalogTable
          entries={[
            {
              ...entry,
              evaluation: {
                ...entry.evaluation,
                status: 'stale',
                profit: { amount: 10, currency: 'chaos' },
                marginPercent: 20,
                source: {
                  capturedAt: '2026-11-04T10:00:00.000Z',
                  comparableSellers: 1,
                  coverage: 'complete',
                },
              },
            },
          ]}
          filters={defaultCatalogFilters}
          onSort={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Outdated');
    expect(html).toContain('20.0%');
    expect(html).not.toContain('ROI withheld');
  });

  it('shows the blocker and explains a loading row without evidence', () => {
    const entry = catalogFixtures[0]!;
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CatalogTable
          entries={[
            {
              ...entry,
              snapshot: null,
              evaluation: {
                ...entry.evaluation,
                profit: null,
                marginPercent: null,
                profitBlockedReason: 'Paid finish is outside the cost model.',
                source: {
                  capturedAt: '2026-11-04T10:00:00.000Z',
                  comparableSellers: 1,
                  coverage: 'complete',
                },
              },
            },
            {
              ...entry,
              recipe: {
                ...entry.recipe,
                id: 'loading',
                targetSignature: 'loading-target',
              },
              snapshot: null,
              evaluation: {
                ...entry.evaluation,
                status: 'loading',
                profit: null,
                marginPercent: null,
              },
            },
          ]}
          filters={defaultCatalogFilters}
          onSort={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).toContain(
      'ROI withheld: Paid finish is outside the cost model.',
    );
    expect(html).not.toContain('Single ask · ROI withheld');
    expect(html).toContain('Awaiting output observation');
    expect(html).not.toContain('Updating');
  });

  it('exposes sortable column headers and readable full item names', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CatalogTable
          entries={catalogFixtures}
          filters={{ ...defaultCatalogFilters, sort: 'roi', direction: 'desc' }}
          onSort={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('<table');
    expect(html).toMatch(/<thead\b/);
    expect(html.match(/scope="col"/g)).toHaveLength(6);
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('cluster jewel');
    expect(html).toContain('Market evidence');
    expect(html).toContain(catalogFixtures[0]!.recipe.title);
  });
  it('keeps the table headers available when filters match nothing', () => {
    const html = renderToStaticMarkup(
      <CatalogTable
        entries={[]}
        filters={defaultCatalogFilters}
        onSort={() => {}}
      />,
    );
    expect(html).toMatch(/<thead\b/);
    expect(html).toContain('No items match');
    expect(html).toContain('colSpan="3"');
  });
});
