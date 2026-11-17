import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App.js';
import {
  selectedRecipe,
  workspaceHref,
  workspaceSections,
} from './workspaceNavigation.js';

describe('workspace navigation context', () => {
  it('carries the selected target, method, league, currency and period across sections', () => {
    const href = workspaceHref(
      '/market?view=history',
      '/recipes/stale-boots',
      '?recipe=old&league=Covens&currency=divine&method=essence&range=7d&search=boots&batch=old',
    );
    const params = new URL(href, 'https://test.invalid').searchParams;
    expect(Object.fromEntries(params)).toEqual({
      view: 'history',
      recipe: 'stale-boots',
      league: 'Covens',
      currency: 'divine',
      method: 'essence',
      range: '7d',
    });
    expect(workspaceHref('/recipes/new', '/recipes/old', '?recipe=old')).toBe(
      '/recipes/new?recipe=new',
    );
  });
  it('preserves explicit destination context and keeps batch selection inside the workshop', () => {
    const href = workspaceHref(
      '/factory?recipe=new&league=Standard',
      '/recipes/new',
      '?batch=old&league=Covens',
    );
    expect(href).toBe('/factory?recipe=new&league=Standard');
    expect(
      workspaceHref(
        '/factory?view=sales',
        '/factory',
        '?batch=actual&league=Covens',
      ),
    ).toContain('batch=actual');
    expect(workspaceHref('https://example.com', '/', '?recipe=private')).toBe(
      'https://example.com',
    );
    expect(selectedRecipe('/recipes/%E0%A4%A', '')).toBeNull();
  });
  it('provides exactly the 20 requested views and asks for a selection instead of choosing a fixture', () => {
    expect(
      workspaceSections.reduce(
        (total, section) => total + section.tabs.length,
        0,
      ),
    ).toBe(20);
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/?view=budget']}>
        <App />
      </MemoryRouter>,
    );
    expect(html).toContain('Выберите целевой предмет');
    expect(html).not.toContain('Fettle');
    expect(html).not.toContain('/recipes/profitable-cluster');
  });
});
