import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { App } from './App.js';
import { formatAge, Money, ProfitBadge, economicClass } from './components.js';

describe('application shell', () => {
  it('renders catalog and recipe routes inside the shared shell', () => {
    const catalog = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    const recipe = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/recipes/physical-large-cluster']}>
        <App />
      </MemoryRouter>,
    );

    expect(catalog).toContain('Worksmith Handbook');
    expect(catalog).toContain('Loading recipes');
    expect(catalog).not.toContain('Рынок');
    expect(recipe).toContain('Loading recipe');
    expect(recipe).toContain('Recipes');
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

it.each([
  [-3.5, 'economic-negative', '-3.5'],
  [4, 'economic-positive', '+4'],
  [0, 'economic-unknown', '0'],
] as const)(
  'renders signed economics with readable polarity for %s',
  (amount, tone, label) => {
    const html = renderToStaticMarkup(
      <ProfitBadge amount={amount} currency="chaos" />,
    );
    expect(html).toContain(tone);
    expect(html).toContain(`${label} c`);
    expect(economicClass(amount)).toBe(tone);
  },
);
