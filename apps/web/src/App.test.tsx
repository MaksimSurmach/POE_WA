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
    expect(recipe).toContain('Cost breakdown');
    expect(recipe).toContain('Top 10 Merchant listings');
  });

  it.each([
    ['/recipes/stale-boots', 'Market provider temporarily unavailable'],
    ['/recipes/no-listings-bow', 'No market listings yet'],
    ['/recipes/calculation-error-amulet', 'Calculation unavailable'],
    ['/recipes/invalid-recipe', 'Recipe configuration is invalid'],
    ['/recipes/loading-gloves', 'No market data yet'],
  ])('renders the explicit detail state for %s', (route, message) => {
    const page = renderToStaticMarkup(
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>,
    );

    expect(page).toContain(message);
  });

  it('keeps healthy recipes visible when one recipe fails', () => {
    const catalog = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    expect(catalog).toContain('Physical Large Cluster Jewel');
    expect(catalog).toContain('Invalid Recipe Fixture');
    expect(catalog).toContain('evaluation-status--error');
  });
});

describe('shared presentation primitives', () => {
  it('formats prices and age boundaries consistently', () => {
    expect(
      renderToStaticMarkup(
        <Money price={{ amount: 4.1, currency: 'divine' }} />,
      ),
    ).toContain('4.1 div');
    expect(
      renderToStaticMarkup(
        <Money price={{ amount: 0.0003, currency: 'divine' }} />,
      ),
    ).toContain('0.0003 div');
    expect(formatAge(59)).toBe('59 sec ago');
    expect(formatAge(120)).toBe('2 min ago');
    expect(formatAge(7200)).toBe('2 hr ago');
    expect(formatAge(172800)).toBe('2 d ago');
  });
});
