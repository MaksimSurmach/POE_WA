import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRecipeCatalog } from './recipes/loader.js';
import { normalizeTradeCompatibleListing } from './providers/tradeCompatible.js';
import { createMarketTarget } from './marketResearch.js';

const catalogPath = fileURLToPath(new URL('../../../recipes', import.meta.url));

describe('3.30 first-week catalog', () => {
  it('normalizes local bow damage using the Trade average of both damage endpoints', () => {
    const target = createMarketTarget({
      name: 'Physical bow',
      game: 'poe1',
      realm: 'pc',
      league: 'Standard',
      patch: '3.30.0',
      slot: 'bow',
      baseTypes: ['Spine Bow'],
      builds: [],
      requiredMods: [],
      sources: [],
    });
    const result = normalizeTradeCompatibleListing(
      {
        id: 'physical-bow',
        listing: {
          price: { amount: 10, currency: 'chaos' },
          account: { name: 'seller' },
        },
        item: {
          baseType: 'Spine Bow',
          frameType: 2,
          ilvl: 83,
          league: 'Standard',
          explicitMods: ['Adds 31 to 65 Physical Damage'],
        },
      },
      target,
    );
    expect(result.item.mods).toContainEqual({
      id: 'explicit.stat_1940865751',
      value: 48,
    });
  });

  it('does not carry historical cost certification into permanent leagues across the patch', async () => {
    for (const { definition } of await loadRecipeCatalog(catalogPath)) {
      if (definition.patch !== '3.29.3.3') continue;
      expect(definition.verification.leagues, definition.id).not.toContain(
        'Standard',
      );
      expect(definition.verification.leagues, definition.id).not.toContain(
        'Hardcore',
      );
      expect(definition.verification.leagues, definition.id).not.toContain(
        'Covens of Umbra',
      );
    }
  });

  it('covers affordable starting gear and premium bases without unverified cost estimates', async () => {
    const catalog = await loadRecipeCatalog(catalogPath);
    const starters = catalog.filter(({ definition }) =>
      definition.tags.includes('week-one'),
    );
    expect(starters.length).toBeGreaterThanOrEqual(20);
    expect(
      new Set(starters.map(({ definition }) => definition.category)),
    ).toEqual(
      new Set([
        'belt',
        'helmet',
        'gloves',
        'boots',
        'bow',
        'quiver',
        'body-armour',
        'shield',
      ]),
    );
    for (const { definition: recipe } of starters) {
      expect(recipe.patch).toBe('3.30.0');
      expect(recipe.verification.status).toBe('unverified');
      expect(recipe.verification.leagues).toEqual([]);
      expect(recipe.craft.expectedExecutions).toBeUndefined();
      expect(recipe.craft.baseConsumption).toBeUndefined();
      expect(recipe.craft.steps.every((step) => !step.success)).toBe(true);
      expect(recipe.startingBase.state).toEqual({
        corrupted: false,
        fractured: false,
        synthesised: false,
      });
      expect(recipe.startingBase.influences).toEqual([]);
      expect(recipe.craft.steps).toHaveLength(1);
      expect(recipe.craft.uncertainties.join(' ')).toContain('3.30');
    }
    const bone = starters.find(
      ({ definition }) => definition.base.baseId === 'base:bone-helmet',
    )?.definition;
    expect(bone?.target.implicits).toContainEqual({
      excluded: false,
      kind: 'implicit',
      modId: 'mod:implicit-minion-damage',
      minimumValue: 20,
    });
    const leather = starters.find(
      ({ definition }) => definition.base.baseId === 'base:leather-belt',
    )?.definition;
    expect(leather?.target.prefixes).toContainEqual({
      excluded: false,
      kind: 'explicit',
      modId: 'mod:life',
      minimumValue: 100,
    });
    expect(leather?.craft.method).toEqual({
      kind: 'currency',
      currency: 'deafening-essence-of-envy',
    });
  });
});
