import { describe, expect, it } from 'vitest';
import { filterPohxGuides, pohxGuides } from './pohxGuides.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { RecipeLibrary } from './RecipeLibraryPage.js';
import { catalogFixtures } from './mocks/catalog.js';

describe('Pohx crafting library', () => {
  it('includes all 27 source guides, with the unfinished source explicitly unavailable', () => {
    expect(pohxGuides).toHaveLength(27);
    expect(new Set(pohxGuides.map((g) => g.id)).size).toBe(27);
    expect(pohxGuides.filter((g) => g.workInProgress).map((g) => g.id)).toEqual(
      ['advanced-abyss-socket-mittens'],
    );
    for (const guide of pohxGuides) {
      expect(guide.sourceUrl).toBe(`https://pohx.net/crafts/${guide.id}/`);
      expect(new Set(guide.materials).size).toBe(guide.materials.length);
      if (guide.workInProgress) expect(guide.steps).toEqual([]);
      else {
        expect(guide.steps.length).toBeGreaterThan(1);
        expect(guide.materials.length).toBeGreaterThan(0);
      }
    }
  });
  it('keeps source guides searchable without market data or profitability assumptions', () => {
    expect(filterPohxGuides('totem', 'shield').map((g) => g.id)).toContain(
      'totem-shield',
    );
    expect(filterPohxGuides('', 'helmet')).toHaveLength(6);
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/recipes?source=pohx&category=shield']}>
        <RecipeLibrary entries={catalogFixtures} />
      </MemoryRouter>,
    );
    expect(html).toContain('RF Totem Shield');
    expect(html).not.toContain('href="/recipes/physical-large-cluster');
    const offline = renderToStaticMarkup(
      <MemoryRouter>
        <RecipeLibrary entries={[]} />
      </MemoryRouter>,
    );
    expect(offline).toContain('27 of 27');
  });
});
