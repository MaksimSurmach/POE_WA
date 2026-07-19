import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { App } from './App.js';
import { formatAge, Money } from './components.js';

describe('application shell', () => {
  it('renders catalog and recipe routes inside the shared shell', () => {
    const catalog = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    const recipe = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/recipes/profitable-cluster']}>
        <App />
      </MemoryRouter>,
    );

    expect(catalog).toContain('Craft catalog');
    expect(recipe).toContain('Physical Large Cluster Jewel');
    expect(recipe).toContain('Back to catalog');
  });
});

describe('shared presentation primitives', () => {
  it('formats prices and age boundaries consistently', () => {
    expect(
      renderToStaticMarkup(
        <Money price={{ amount: 4.1, currency: 'divine' }} />,
      ),
    ).toContain('4.1 div');
    expect(formatAge(59)).toBe('59 sec ago');
    expect(formatAge(120)).toBe('2 min ago');
    expect(formatAge(7200)).toBe('2 hr ago');
    expect(formatAge(172800)).toBe('2 d ago');
  });
});
