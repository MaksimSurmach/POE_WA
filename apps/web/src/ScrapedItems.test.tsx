import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ScrapedItemCaptureReport } from './ScrapedItemCaptureReport.js';
import { ScrapedItemEditor } from './ScrapedItemEditor.js';
import { ScrapedItemsPage } from './ScrapedItemsPage.js';
import { SettingsNav } from './SettingsNav.js';
import { fixtureCapture, fixtureItem } from './mocks/scrapedItems.js';

const client = {
  save: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  searchModifiers: vi.fn(),
  startTest: vi.fn(),
  readTest: vi.fn(),
  readCapture: vi.fn(),
  list: vi.fn(),
};
const recipes = [
  {
    base: fixtureItem.id,
    id: 'recipe-a',
    output: fixtureItem.id,
    title: 'Recipe A',
  },
  { base: null, id: 'recipe-d', output: null, title: 'Recipe D' },
];

function editor(
  overrides: Partial<Parameters<typeof ScrapedItemEditor>[0]> = {},
) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ScrapedItemEditor
        client={client}
        collectionsPaused={false}
        item={fixtureItem}
        leagueName="Fixture League"
        recipes={recipes}
        onItemChanged={() => undefined}
        onReload={async () => undefined}
        {...overrides}
      />
    </MemoryRouter>,
  );
}

describe('Scraped items editor', () => {
  it('opens exactly the generated Trade search in a new, safe tab', () => {
    const html = editor();
    expect(html).toContain(`href="${fixtureItem.query.tradeUrl}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('opens in a new tab');
  });

  it('names canonical modifiers and IDs, and flags a modifier without a Trade mapping', () => {
    const html = editor();
    expect(html).toContain('Battle-Hardened');
    expect(html).toContain('mod:battle-hardened');
    expect(html).toContain('No Trade mapping');
    expect(html).toContain('required modifier has no');
    // Typed, validated numeric controls instead of free text.
    expect(html).toMatch(/type="number"[^>]*min="1"[^>]*max="100"/);
  });

  it('shows every linked recipe, drift and the recipes sharing the search', () => {
    const html = editor();
    expect(html).toContain('Recipe A');
    expect(html).toContain('Recipe B');
    expect(html).toContain('Recipe updated after linking');
    expect(html).toContain('Also served by the same search');
    expect(html).toContain('Recipe C');
    expect(html).toContain('Saving changes the search for 2 recipes');
    // Only recipes not already on this item can be linked.
    expect(html).toContain('Recipe D');
    expect(html).toContain('aria-label="Unlink Recipe A"');
  });

  it('keeps edits and tests honest: a test is only for the saved revision', () => {
    const html = editor();
    expect(html).toContain('Run test');
    expect(html).toContain('Queues only this search');
    expect(html).toContain('Reported by Trade');
    expect(html).toContain('Complete');
    expect(html).toMatch(/Save requirements/);
    // Nothing is saved or tested merely by rendering.
    for (const call of Object.values(client))
      expect(call).not.toHaveBeenCalled();
  });

  it('blocks testing while collection is paused or the search cannot be built', () => {
    expect(editor({ collectionsPaused: true })).toContain(
      'Collection is paused',
    );
    const blocked = editor({
      item: {
        ...fixtureItem,
        query: {
          diagnostics: [
            {
              code: 'TRADE_MAPPING_MISSING',
              entityId: 'mod:unmapped',
              message: 'Expected one PoE Trade target mapping',
            },
          ],
          key: null,
          status: 'blocked',
          tradeUrl: null,
        },
      },
    });
    expect(blocked).toContain('This search cannot be built');
    expect(blocked).toContain('TRADE_MAPPING_MISSING');
    expect(blocked).not.toContain('Open Trade search');
    expect(blocked).toContain('does not compile, so it cannot be tested');
  });

  it('labels every control, announces status, and avoids color-only meaning', () => {
    const html = editor();
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    expect(html).toMatch(/<legend[^>]*>Influences/);
    expect(html).toContain(
      '<caption class="visually-hidden">Linked recipes</caption>',
    );
    // Every input sits inside a label.
    expect((html.match(/<label/g) ?? []).length).toBeGreaterThan(8);
  });
});

describe('Capture report', () => {
  it('keeps collection quality apart from matching and does not call a complete capture a failure', () => {
    const html = renderToStaticMarkup(
      <ScrapedItemCaptureReport capture={fixtureCapture} />,
    );
    expect(html).toContain('aria-label="Collection"');
    expect(html).toContain('aria-label="Comparability"');
    expect(html).toContain('Reported by Trade');
    expect(html).toContain('Listings fetched');
    expect(html).toContain('Comparable sellers');
    expect(html).toContain('a matching result, not a scraping failure');
    expect(html).toContain('base: mismatch');
    expect(html).toContain('Unknown');
  });

  it('explains partial coverage and listings that are no longer retained', () => {
    const html = renderToStaticMarkup(
      <ScrapedItemCaptureReport
        capture={{
          ...fixtureCapture,
          coverage: 'partial',
          partialReason: 'SEARCH_TRUNCATED',
          listings: null,
          listingsUnavailable: 'superseded-by-later-capture',
          reasons: [],
        }}
      />,
    );
    expect(html).toContain('Partial');
    expect(html).toContain('SEARCH_TRUNCATED');
    expect(html).toContain('a later capture replaced this one');
    expect(html).not.toContain('scraping failure');
  });
});

describe('Settings navigation', () => {
  const nav = (path: string) =>
    renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>
        <SettingsNav />
      </MemoryRouter>,
    );

  it('announces the current settings page', () => {
    const html = nav('/settings/scraped-items');
    expect(html).toContain('aria-label="Settings sections"');
    expect(html).toMatch(/aria-current="page"[^>]*>Scraped items/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(nav('/settings')).toMatch(/aria-current="page"[^>]*>Collection/);
    expect(nav('/settings?view=data')).toMatch(
      /aria-current="page"[^>]*>Data and sources/,
    );
  });

  it('links the Scraped items page', () => {
    expect(nav('/settings')).toContain('href="/settings/scraped-items"');
  });
});

describe('Scraped items page', () => {
  it('requests nothing before mount and never shows invented data', () => {
    const list = vi.fn();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ScrapedItemsPage client={{ ...client, list }} />
      </MemoryRouter>,
    );
    expect(html).toContain('<h1>Scraped items</h1>');
    expect(html).toContain('Loading scraped items');
    expect(html).not.toContain('Large Cluster Jewel');
  });
});
