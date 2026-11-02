import type { PresentedItem } from '@poe-worksmith/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ItemTooltip } from './ItemTooltip.js';

const item = {
  canonicalId: 'Metadata/Items/Jewels/LargeCluster',
  iconUrl: null,
  itemClass: 'Jewel',
  itemLevel: 84,
  modifiers: [
    {
      canonicalId: 'physical-notable',
      generationType: 'prefix',
      label: 'Physical notable passive skills',
    },
  ],
  name: 'Large Cluster Jewel',
  properties: [{ id: 'passives', label: 'Passive Skills', value: '8' }],
  rarity: 'rare',
  role: 'target',
} satisfies PresentedItem;

describe('ItemTooltip', () => {
  it('labels a target definition and exposes its item properties and modifiers', () => {
    const markup = renderToStaticMarkup(<ItemTooltip item={item} />);
    expect(markup).toContain('Target item definition');
    expect(markup).toContain('Item Level 84');
    expect(markup).toContain('Passive Skills: 8');
    expect(markup).toContain('Physical notable passive skills');
    expect(markup).toContain('aria-expanded="false"');
  });

  it('renders the supplied base item artwork', () => {
    const markup = renderToStaticMarkup(
      <ItemTooltip
        item={{ ...item, iconUrl: 'https://example.test/base.png' }}
      />,
    );
    expect(markup).toContain('src="https://example.test/base.png"');
  });
});
