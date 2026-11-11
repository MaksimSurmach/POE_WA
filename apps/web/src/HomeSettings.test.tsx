import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { HomeSettings } from './HomeSettings.js';

it('renders settings collapsed and requests nothing until opened', () => {
  // `pause` stays accepted so existing callers keep compiling; it is unused.
  const client = { settings: vi.fn(), save: vi.fn(), pause: vi.fn() };
  const html = renderToStaticMarkup(<HomeSettings client={client} />);
  expect(html).toContain('<details class="market-admin__drawer">');
  expect(html).toContain('Settings');
  expect(html).not.toContain('<form');
  // Pause/resume is owned by the collector controls, not this drawer.
  expect(html).not.toMatch(/Pause|Resume/);
  for (const call of Object.values(client)) expect(call).not.toHaveBeenCalled();
});
