import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { HomeSettings } from './HomeSettings.js';

it('renders settings collapsed and requests nothing until opened', () => {
  const client = { settings: vi.fn(), save: vi.fn(), pause: vi.fn() };
  const html = renderToStaticMarkup(<HomeSettings client={client} />);
  expect(html).toContain('<details class="market-admin__drawer">');
  expect(html).toContain('Settings');
  expect(html).not.toContain('<form');
  for (const call of Object.values(client)) expect(call).not.toHaveBeenCalled();
});
