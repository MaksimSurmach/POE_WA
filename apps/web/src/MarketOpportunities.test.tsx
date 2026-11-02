import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BeltOpportunity } from '@poe-worksmith/contracts';
import { MarketOpportunities } from './MarketOpportunities.js';
import { MarketCraftCosts } from './MarketCraftCosts.js';

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
  it('renders readable cost components and safe dated sources, with a fallback for legacy JSON', () => {
    const money = (amount: string) => ({ amount, currency: 'chaos' });
    const calculation = {
      expectedCraftCost: '342.736',
      askingPrice: '250',
      spread: '-92.736',
      currency: 'chaos',
      breakdown: {
        base: {
          id: 'base',
          label: 'Archdemon Crown',
          quantity: '1',
          total: money('250'),
        },
        expectedAttempts: '94',
        expectedMaterials: money('88.736'),
        finishingTotal: money('4'),
        materials: [
          {
            id: 'wild',
            label: 'Wild Lifeforce',
            quantity: '50',
            total: money('0.944'),
          },
        ],
        baseReplacement: { expectedReplacements: '0', netCost: money('0') },
      },
    };
    const html = renderToStaticMarkup(
      <MarketCraftCosts
        opportunity={{
          ...row,
          calculation,
          priceEvidence: [
            null,
            { url: 'javascript:bad' },
            {
              url: 'https://poe.ninja/quote',
              name: 'Wild',
              capturedAt: '2026-11-02T00:00:00Z',
            },
          ],
        }}
      />,
    );
    for (const text of [
      'Archdemon Crown',
      '250 chaos',
      '94',
      '50 за попытку',
      '88,74 chaos',
      '4 chaos',
      '342,74 chaos',
      'Замены базы',
      'https://poe.ninja/quote',
      '2026-11-02T00:00:00Z',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('javascript:');
    const legacy = renderToStaticMarkup(
      <MarketCraftCosts
        opportunity={{ ...row, calculation: { ...calculation, breakdown: {} } }}
      />,
    );
    expect(legacy).toContain('Подробный состав затрат недоступен.');
  });
  it('shows the calculation price separately from the displayed market median', () => {
    const calculated: BeltOpportunity = {
      ...row,
      status: 'CALCULATED',
      economicConclusion: 'NON_POSITIVE',
      calculation: {
        expectedCraftCost: '342.736',
        askingPrice: '250',
        spread: '-92.736',
        roiPercent: '-27.057',
        currency: 'chaos',
        breakdown: {},
      },
    };
    const html = renderToStaticMarkup(
      <MarketOpportunities
        rows={[calculated]}
        selectedId=""
        onSelect={() => {}}
        renderDetails={() => null}
      />,
    );
    expect(html).toContain('200 chaos');
    expect(html).toContain('В расчёте: 250 chaos');
    expect(html).toContain('-92,74 chaos');
  });
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
