import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { WorkspaceShell } from './WorkspaceShell.js';

it('uses the same favorites toggle on Home and the recipe catalogue', () => {
  for (const path of ['/?favorites=1', '/recipes?favorites=1']) {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>
        <WorkspaceShell />
      </MemoryRouter>,
    );
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Favorites/);
    expect(html).not.toContain('Display density');
  }
});

it('keeps favorites reachable from legacy recipe detail views', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/recipes?view=recipe&recipe=exact-id']}>
      <WorkspaceShell />
    </MemoryRouter>,
  );
  expect(html).toContain('/recipes?favorites=1&amp;recipe=exact-id');
});
