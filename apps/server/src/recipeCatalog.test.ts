import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  RegisteredTradeQueryGenerator,
  clusterJewelVariantFilter,
  noVariantFilter,
  mappedTargetFilter,
} from '@poe-worksmith/domain';
import { describe, expect, it } from 'vitest';
import { loadRecipeCatalog } from './recipes/loader.js';
import {
  createRecipeMarketDependencies,
  generateRecipeMarketQuery,
  recipeQueryTarget,
} from './recipeMarket.js';
import { normalizeTradeCompatibleListing } from './providers/tradeCompatible.js';
import { createImportedMarketSnapshot } from './marketResearch.js';
import { analyzeBeltSnapshot } from './beltComparability.js';
import {
  createRecipeItemPresentation,
  loadItemPresentationCatalog,
} from './itemPresentation.js';
import { loadAndValidateTradeMappingManifest } from './tradeMappings.js';

const root = new URL('../../../', import.meta.url);
const recipes = () =>
  loadRecipeCatalog(fileURLToPath(new URL('recipes', root)));
const receipt = new URL(
  'docs/evidence/recipe-catalog-2026-11-03/trade-identities.json',
  root,
);
async function mappedTrade() {
  const identities = JSON.parse(await readFile(receipt, 'utf8'));
  const manifests = await Promise.all(
    ['physical-large-cluster', 'recipe-catalog'].map(async (name) => {
      const file = fileURLToPath(
        new URL(`../mappings/poe-trade/3.29.3.3/${name}.json`, import.meta.url),
      );
      if (name === 'physical-large-cluster')
        return JSON.parse(await readFile(file, 'utf8'));
      const validated = await loadAndValidateTradeMappingManifest(
        file,
        async (url) =>
          new Response(
            JSON.stringify({
              result: [
                {
                  entries: String(url).endsWith('/stats')
                    ? identities.stats
                    : [
                        ...identities.bases,
                        ...identities.resources.map((r: { name: string }) => ({
                          type: r.name,
                        })),
                      ],
                },
              ],
            }),
          ),
      );
      return { mappings: validated.mappings };
    }),
  );
  const mappings = manifests.flatMap((m) => m.mappings);
  return new RegisteredTradeQueryGenerator(
    {
      async resolveBase({ baseId }) {
        const mapping = mappings.find(
          (m: { entityKind: string; canonicalId: string }) =>
            m.entityKind === 'base' && m.canonicalId === baseId,
        );
        if (!mapping) throw new Error(`Unmapped base ${baseId}`);
        return {
          ok: true,
          diagnostics: [],
          value: {
            id: mapping.externalId,
            mappingVersion: 'receipt',
            ...(mapping.payload?.filters
              ? { filters: mapping.payload.filters }
              : {}),
          },
        };
      },
      async resolveTarget({ target }) {
        const mapping = mappings.find(
          (m: { entityKind: string; canonicalId: string }) =>
            m.entityKind === 'mod' && m.canonicalId === target.modId,
        );
        if (!mapping) throw new Error(`Unmapped target ${target.modId}`);
        return { ok: true, diagnostics: [], value: { id: mapping.externalId } };
      },
    },
    [noVariantFilter, clusterJewelVariantFilter],
    [mappedTargetFilter],
  );
}

describe('authored source catalog integrity', () => {
  it('loads every current recipe with resolvable target/base identities, material slugs and readable presentation', async () => {
    const catalog = await recipes();
    expect(catalog).toHaveLength(15);
    const trade = await mappedTrade();
    const presentation = await loadItemPresentationCatalog(
      fileURLToPath(
        new URL(
          '../presentation/poe1/3.29.3.3/physical-large-cluster.json',
          import.meta.url,
        ),
      ),
    );
    const resources = JSON.parse(
      await readFile(
        new URL(
          '../mappings/poe-trade/3.29.3.3/recipe-catalog.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ).mappings;
    const oldResources = JSON.parse(
      await readFile(
        new URL(
          '../mappings/poe-trade/3.29.3.3/physical-large-cluster.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ).mappings;
    const dependencies = createRecipeMarketDependencies({
      trade,
      resolveResource: async (id) => {
        const resource = [...resources, ...oldResources].find(
          (m: { entityKind: string; canonicalId: string }) =>
            m.entityKind === 'resource' && m.canonicalId === id,
        );
        if (!resource) throw new Error(`Unmapped resource ${id}`);
        return resource.payload?.exchangeId ?? null;
      },
    });
    for (const { definition } of catalog) {
      await expect(
        dependencies({ recipe: definition, league: 'Fixture League' }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'base' }),
          expect.objectContaining({ kind: 'target' }),
        ]),
      );
      const view = createRecipeItemPresentation({
        catalog: presentation,
        recipe: definition,
      });
      expect(view.base.itemClass).not.toBe('Unknown');
      expect(
        view.target.modifiers.every((m) => !m.label.startsWith('mod:')),
      ).toBe(true);
      if (definition.tags.includes('research-2026-11-03')) {
        expect(definition.verification.status).toBe('unverified');
        expect(definition.craft.expectedExecutions).toBeUndefined();
        expect(definition.craft.baseConsumption).toBeUndefined();
      }
    }
  });

  it('preserves all sixteen Sheet candidates and separates recovered formula text from raw errors', async () => {
    const projection = JSON.parse(
      await readFile(
        new URL(
          'docs/evidence/recipe-catalog-2026-11-03/candidate-projection.json',
          root,
        ),
        'utf8',
      ),
    );
    expect(projection.candidates.map((c: { id: string }) => c.id)).toEqual(
      Array.from(
        { length: 16 },
        (_, i) => `C${String(i + 1).padStart(3, '0')}`,
      ),
    );
    const wand = projection.candidates.find(
      (c: { id: string }) => c.id === 'C007',
    );
    expect(wand.raw['Название']).toBe('#ERROR!');
    expect(wand.recoveredFormulaText['Название']).toBe(
      '+2 Minion Convoking Wand',
    );
  });

  it('accepts fractured suppression and excludes the same numeric explicit roll on a different fracture', async () => {
    const recipe = (await recipes()).find(
      (r) => r.definition.id === 'suppression-gloves-zeal',
    )?.definition;
    if (!recipe) throw new Error('Missing suppression recipe');
    const target = recipeQueryTarget(
      (
        await generateRecipeMarketQuery(
          await mappedTrade(),
          recipe,
          'Fixture League',
        )
      ).query.handbookTarget,
    );
    const raw = (fracturedSuppression: boolean) => ({
      id: fracturedSuppression ? 'correct' : 'wrong-fracture',
      listing: {
        price: { amount: 10, currency: 'chaos' },
        account: { name: 'fixture' },
      },
      item: {
        verified: true,
        baseType: 'Dragonscale Gauntlets',
        frameType: 2,
        league: 'Fixture League',
        ilvl: 85,
        influences: {},
        explicitMods: [
          '+110 to maximum Life',
          '16% increased Attack Speed',
          ...(fracturedSuppression
            ? []
            : ['+14% chance to Suppress Spell Damage']),
        ],
        fracturedMods: fracturedSuppression
          ? ['+14% chance to Suppress Spell Damage']
          : ['+30% to Fire Resistance'],
      },
    });
    const now = new Date('2026-11-03T00:00:00.000Z');
    const rows = [true, false].map((fracture) =>
      normalizeTradeCompatibleListing(raw(fracture), target),
    );
    const snapshot = createImportedMarketSnapshot(
      {
        targetId: target.id,
        capturedAt: now.toISOString(),
        sourceUrl: 'https://example.com/fixture',
        currency: 'chaos',
        dataKind: 'demo',
        listings: rows,
      },
      target,
      now,
    );
    const compared = analyzeBeltSnapshot(target, snapshot, now.getTime());
    expect(compared.rows[0]?.status, JSON.stringify(compared.rows)).toBe(
      'MATCH',
    );
    expect(compared.rows[1]?.status).not.toBe('MATCH');
  });
});
