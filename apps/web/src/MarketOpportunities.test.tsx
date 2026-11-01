import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BeltOpportunity } from '@poe-worksmith/contracts';
import { MarketOpportunities } from './MarketOpportunities.js';

const row: BeltOpportunity = {
  targetId: 'profile',
  targetDigest: 'digest',
  name: 'Test belt',
  league: 'Current',
  patch: 'test',
  builds: ['Test build'],
  sources: [],
  rules: null,
  method: null,
  snapshotId: 'snapshot',
  dataKind: 'observed',
  capturedAt: '2026-11-01T12:00:00Z',
  sourceUrl: null,
  comparison: {
    algorithm: 'trade-comparability-v1',
    targetDigest: 'digest',
    snapshotId: 'snapshot',
    dataKind: 'observed',
    capturedAt: '2026-11-01T12:00:00Z',
    currency: 'chaos',
    status: 'INSUFFICIENT_DATA',
    reasons: [],
    selectionBias: 'Asking prices',
    independentSellers: 7,
    confirmedListings: 7,
    conservativeAskingPrice: 100,
    askingDistribution: { min: 100, median: 200, max: 300 },
    rows: [],
  },
  priceEvidence: [],
  calculation: null,
  status: 'INSUFFICIENT_DATA',
  economicConclusion: null,
  reasons: ['Missing craft estimate'],
  queryUrl: 'https://www.pathofexile.com/trade/search/Current/query',
  freshness: 'FRESH',
  confidence: 'LOW',
};

describe('opportunity rows', () => {
  it('shows matched market prices without inventing a craft calculation, and opens only the selected details', () => {
    const render = (selectedId: string) =>
      renderToStaticMarkup(
        <MarketOpportunities
          rows={[row]}
          selectedId={selectedId}
          onSelect={() => {}}
          renderDetails={() => <p>Craft variants</p>}
        />,
      );
    const closed = render('');
    expect(closed).toContain('200 chaos');
    expect(closed).toContain('Нет оценки');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('Craft variants');
    const opened = render(row.targetId);
    expect(opened).toContain('aria-expanded="true"');
    expect(opened).toContain('Craft variants');
    expect(opened).toContain('aria-label="Trade: Test belt"');
  });
});
