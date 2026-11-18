import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { PresentedItem } from '@poe-worksmith/contracts';
import {
  TargetRequirements,
  TargetDetailDialog,
} from './TargetDetailDialog.js';
import { selectRecipeLibrary } from './recipeLibraryModel.js';
import { catalogFixtures } from './mocks/catalog.js';

it('keeps structural properties, enchanted base properties and affix predicates in their supplied groups', () => {
  const item: PresentedItem = {
    canonicalId: 'base:test',
    name: 'Test base',
    iconUrl: null,
    itemClass: 'Helmet',
    itemLevel: 85,
    rarity: null,
    role: 'target',
    properties: [
      { id: 'item-level', label: 'Item Level', value: '85' },
      { id: 'quality', label: 'Quality', value: null },
      { id: 'base-armour', label: 'Armour', value: 'Required base' },
    ],
    modifiers: [
      {
        canonicalId: 'life',
        generationType: 'prefix',
        label: 'Maximum Life ≥70',
      },
      {
        canonicalId: 'fire',
        generationType: 'suffix',
        label: 'Fire Resistance ≥42%',
      },
      {
        canonicalId: 'implicit',
        generationType: 'implicit',
        label: 'Implicit requirement ≥5%',
      },
      {
        canonicalId: 'enchant',
        generationType: 'enchant',
        label: 'Required enchantment',
      },
    ],
  };
  const html = renderToStaticMarkup(
    <TargetRequirements
      item={item}
      name="Exact desired outcome"
      category="helmet"
      patch="3.30.0"
      league="Covens"
    />,
  );
  expect(html).toContain('Target item');
  expect(html).toContain('Exact desired outcome');
  expect(html).toContain('Test base');
  expect(html).toContain('Required prefixes <span>1</span>');
  expect(html).toContain('Required suffixes <span>1</span>');
  expect(html).toContain('Maximum Life ≥70');
  expect(html).toContain('Fire Resistance ≥42%');
  expect(html).toContain('Other requirements');
  expect(html).toContain('Implicit requirement ≥5%');
  expect(html.indexOf('Base properties')).toBeLessThan(
    html.indexOf('Required enchantment'),
  );
  expect(html.indexOf('Required enchantment')).toBeLessThan(
    html.indexOf('Required prefixes'),
  );
  expect(html).toContain('<dt>Quality</dt><dd>Unknown</dd>');
  expect(html).toContain('Required outcome · Covens · PC');
  expect(html).not.toContain('Unique');
});

it('omits absent affix sections and leaves missing requirements explicit', () => {
  const html = renderToStaticMarkup(
    <TargetRequirements name="Unknown target" category="jewel" />,
  );
  expect(html).toContain('Structured requirements unavailable.');
  expect(html).not.toContain('Required prefixes');
  expect(html).not.toContain('Required suffixes');
  expect(html).toContain('League unavailable');
});

it('keeps controlled tabs mounted and exact method actions distinct from target selection', () => {
  const output = selectRecipeLibrary(catalogFixtures).outputs[0]!;
  const html = renderToStaticMarkup(
    <TargetDetailDialog
      output={output}
      recipeId={output.recipeIds[0]!}
      tab="market"
      onSelect={() => {}}
      onClose={() => {}}
      leagueName="Covens"
    />,
  );
  expect(html).toContain('aria-controls="market-panel"');
  expect(html).toContain('aria-controls="recipe-panel"');
  expect(html).toContain('id="market-panel"');
  expect(html).toContain('id="recipe-panel"');
  expect(html).toMatch(/id="recipe-panel"[^>]*hidden=""/);
  expect(html).toContain('Methods for this exact output');
  expect(html).toContain('View recipe:');
  expect(html).toContain('Est. craft margin');
  expect(html).toContain(
    'Provisional estimate. Comparable sale price, selling costs and player time are not verified.',
  );
});
