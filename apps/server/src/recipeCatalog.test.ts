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
      const exchangeIds = new Set(
        identities.resources.map((r: { id: string }) => r.id),
      );
      for (const mapping of validated.mappings) {
        if (mapping.entityKind === 'resource' && mapping.payload?.exchangeId)
          expect(exchangeIds.has(mapping.payload.exchangeId)).toBe(true);
      }
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
        if (target.kind === 'fractured' || target.kind === 'implicit')
          expect(mapping.externalId.startsWith(`${target.kind}.`)).toBe(true);
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
    expect(catalog).toHaveLength(26);
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
      const baseQuery = await generateRecipeMarketQuery(
        trade,
        definition,
        'Fixture League',
        true,
      );
      const targetQuery = await generateRecipeMarketQuery(
        trade,
        definition,
        'Fixture League',
      );
      expect(recipeQueryTarget(baseQuery.query.handbookTarget)).toMatchObject({
        minItemLevel: definition.startingBase.itemLevel,
        maxItemLevel: definition.startingBase.itemLevel,
      });
      expect(
        recipeQueryTarget(targetQuery.query.handbookTarget).maxItemLevel,
      ).toBeUndefined();
      expect(definition.craft.uncertainties).toContain(
        `Starting-base acquisition must use exactly item level ${definition.startingBase.itemLevel}. Higher item levels can change the affix pool and require a separate cost model.`,
      );
      const view = createRecipeItemPresentation({
        catalog: presentation,
        recipe: definition,
      });
      expect(view.base.itemClass).not.toBe('Unknown');
      expect(view.base.iconUrl, definition.id).toMatch(
        /^https:\/\/web\.poecdn\.com\//,
      );
      expect(view.target.iconUrl, definition.id).toBe(view.base.iconUrl);
      expect(
        view.target.modifiers.every((m) => !m.label.startsWith('mod:')),
      ).toBe(true);
      expect(
        definition.tags.some((tag) => /^(max-|research-|sheet-)/.test(tag)),
      ).toBe(false);
      if (definition.verification.status === 'unverified') {
        expect(definition.verification.status).toBe('unverified');
        expect(definition.craft.expectedExecutions).toBeUndefined();
        expect(definition.craft.baseConsumption).toBeUndefined();
      }
    }
  });

  it('ties the two current single-stage expectations to archived exact calculator settings', async () => {
    const catalog = await recipes();
    expect(
      catalog.filter((r) => r.definition.verification.status === 'verified'),
    ).toHaveLength(23);
    for (const method of ['zeal', 'fear']) {
      const recipe = catalog.find(
        (r) => r.definition.id === `suppression-gloves-${method}`,
      )?.definition;
      if (!recipe?.craft.evidence)
        throw new Error('Missing checked essence recipe');
      const receipt = JSON.parse(
        await readFile(new URL(recipe.craft.evidence.artifact, root), 'utf8'),
      );
      const url = new URL(receipt.calculatorURL);
      const details = JSON.parse(
        Buffer.from(url.searchParams.get('details') ?? '', 'base64').toString(
          'utf8',
        ),
      );
      const requirements = JSON.parse(
        Buffer.from(url.searchParams.get('reqs') ?? '', 'base64').toString(
          'utf8',
        ),
      );
      expect(details).toMatchObject({
        i: 'Metadata/Items/Armours/Gloves/GlovesStrDex8',
        l: 85,
        r: 'rare',
        if: [],
        m: [{ k: 'ChanceToSuppressSpells5__', v: [14], f: ['f'] }],
      });
      expect(requirements).toEqual([
        { t: 'and', m: null, e: [{ i: '1022', t: '2', b: true, s: null }] },
      ]);
      expect(recipe.craft.steps[0]?.success?.probability).toBe(
        receipt.displayed.successPercent / 100,
      );
      expect(recipe.craft.expectedExecutions?.[0]?.count).toBe(
        receipt.displayed.expectedEssences,
      );
      expect(recipe.craft.baseConsumption?.expectedBases).toBe(1);
      expect(recipe.verification.leagues).toEqual(['Allflame']);
      const damage = Object.values(recipe.target)
        .flat()
        .find(
          (c) =>
            c.modId ===
            (method === 'zeal' ? 'mod:attack-speed' : 'mod:minion-damage'),
        );
      expect(damage?.minimumValue).toBe(
        receipt.method.guaranteedModifier.range[0],
      );
    }
  });

  it('binds Stygian and wand per-finished material totals to their exact archived AND requirements', async () => {
    const catalog = await recipes();
    for (const id of [
      'stygian-life-resistances-envy',
      'stygian-life-resistances-fossils',
      'minion-convoking-wand-four-fossil',
    ]) {
      const recipe = catalog.find((r) => r.definition.id === id)?.definition;
      if (!recipe?.craft.evidence)
        throw new Error('Missing checked single-stage recipe');
      const receipt = JSON.parse(
        await readFile(new URL(recipe.craft.evidence.artifact, root), 'utf8'),
      );
      const url = new URL(receipt.calculatorURL);
      const details = JSON.parse(
        Buffer.from(url.searchParams.get('details') ?? '', 'base64').toString(
          'utf8',
        ),
      );
      const requirements = JSON.parse(
        Buffer.from(url.searchParams.get('reqs') ?? '', 'base64').toString(
          'utf8',
        ),
      );
      expect(details).toMatchObject({
        i: receipt.startingItem.metadataId,
        l: recipe.startingBase.itemLevel,
        r: recipe.startingBase.rarity,
        if: [],
      });
      expect(requirements).toEqual(receipt.requirements);
      expect(recipe.craft.steps).toHaveLength(1);
      const executions = recipe.craft.expectedExecutions?.[0]?.count;
      expect(executions).toBe(receipt.displayed.expectedExecutions);
      expect(
        Object.fromEntries(
          recipe.craft.steps[0]?.materials.map((m) => [
            m.itemId,
            (m.quantity ?? 0) * (executions ?? 0),
          ]) ?? [],
        ),
      ).toEqual(receipt.displayed.expectedMaterials);
      expect(recipe.craft.steps[0]?.success?.probability).toBeCloseTo(
        receipt.displayed.successPercent / 100,
        10,
      );
      expect(recipe.craft.baseConsumption?.expectedBases).toBe(1);
    }
  });

  it('includes RF vacancy and exactly one paid finish in each current full-chain model', async () => {
    const catalog = await recipes();
    for (const suffix of ['any-support', 'level-20']) {
      const recipe = catalog.find(
        (r) => r.definition.id === `rf-fire-trap-${suffix}`,
      )?.definition;
      if (!recipe?.craft.evidence)
        throw new Error('Missing current RF evidence');
      const receipt = JSON.parse(
        await readFile(new URL(recipe.craft.evidence.artifact, root), 'utf8'),
      );
      const reqs = JSON.parse(
        Buffer.from(
          new URL(receipt.calculatorURL).searchParams.get('reqs') ?? '',
          'base64',
        ).toString('utf8'),
      );
      const tier = suffix === 'level-20' ? '1' : null;
      expect(reqs).toEqual([
        {
          t: 'and',
          m: null,
          e: [
            { i: '2840', t: tier, b: true, s: null },
            { i: '2845', t: tier, b: true, s: null },
            { i: 'special:open-prefix', t: '1', b: true, s: null },
          ],
        },
      ]);
      expect(
        recipe.craft.expectedExecutions?.map((x) => [x.stepId, x.count]),
      ).toEqual([
        ['reforge-fire', receipt.displayed.expectedReforges],
        ['craft-aoe', 1],
      ]);
      expect(receipt.perFinishedItem.materials).toEqual({
        'wild-crystallised-lifeforce': receipt.displayed.expectedReforges * 50,
        'chaos-orb': 4,
      });
      expect(receipt.paidBenchFinish.finishedTargetMatched).toBe(true);
      expect(recipe.craft.baseConsumption?.expectedBases).toBe(1);
    }
    const boots = catalog.find(
      (r) => r.definition.id === 'suppression-boots-loathing',
    )?.definition;
    expect(boots?.craft.expectedExecutions?.[0]?.count).toBe(12);
    expect(boots?.craft.baseConsumption?.expectedBases).toBe(1);
  });

  it('includes gem levels, suffix vacancy and fire compatibility before the single paid Greed finish', async () => {
    const catalog = await recipes();
    for (const [id, tier, minimumLife, mean] of [
      ['minion-bone-helmet-greed', '1', 91, 1907],
      ['minion-fossilised-shield-greed', null, 130, 169],
    ] as const) {
      const recipe = catalog.find((r) => r.definition.id === id)?.definition;
      if (!recipe?.craft.evidence) throw new Error('Missing Greed evidence');
      const receipt = JSON.parse(
        await readFile(new URL(recipe.craft.evidence.artifact, root), 'utf8'),
      );
      const reqs = JSON.parse(
        Buffer.from(
          new URL(receipt.calculatorURL).searchParams.get('reqs') ?? '',
          'base64',
        ).toString('utf8'),
      );
      expect(reqs).toEqual([
        {
          t: 'and',
          m: null,
          e: [
            { i: '769', t: tier, b: true, s: null },
            { i: 'special:open-suffix', t: '1', b: true, s: null },
          ],
        },
        { t: 'not', m: null, e: [{ i: '1038', t: null, b: true, s: null }] },
      ]);
      expect(recipe.craft.steps[0]?.continueWhen).toContain(
        'no native Fire Resistance',
      );
      expect(
        recipe.craft.expectedExecutions?.map((x) => [x.stepId, x.count]),
      ).toEqual([
        ['essence-greed', mean],
        ['craft-fire-resistance', 1],
      ]);
      expect(recipe.craft.steps[1]?.materials).toEqual([
        { itemId: 'chaos-orb', quantity: 3 },
      ]);
      expect(receipt.guaranteedEssenceLife.minimum).toBe(minimumLife);
      expect(
        recipe.target.prefixes.find((x) => x.modId === 'mod:life')
          ?.minimumValue,
      ).toBe(minimumLife);
      expect(receipt.paidBenchFinish.spendingDetails).toEqual({
        item: 'Chaos Orb',
        unitPrice: 1,
        quantity: 3,
        total: 3,
      });
      expect(receipt.paidBenchFinish.finishedTargetMatched).toBe(true);
      expect(recipe.craft.baseConsumption?.expectedBases).toBe(1);
    }
    for (const recipe of catalog) {
      expect(recipe.definition.summary).not.toMatch(
        /MAX-\d+|C0\d\d|Scoped .* procedure/,
      );
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

  it('requires the acquired Bone Helmet minion damage implicit and rejects an explicit substitute or lower roll', async () => {
    const recipe = (await recipes()).find(
      (r) => r.definition.id === 'minion-bone-helmet-greed',
    )?.definition;
    if (!recipe) throw new Error('Missing Bone Helmet recipe');
    const query = await generateRecipeMarketQuery(
      await mappedTrade(),
      recipe,
      'Fixture League',
      true,
    );
    expect(query.query).toMatchObject({
      query: {
        stats: [
          {
            type: 'and',
            filters: [{ id: 'implicit.stat_1589917703', value: { min: 15 } }],
          },
        ],
      },
    });
    const target = recipeQueryTarget(query.query.handbookTarget);
    const raw = (implicitValue: number | null) => ({
      id: String(implicitValue),
      listing: {
        price: { amount: 10, currency: 'chaos' },
        account: { name: 'fixture' },
      },
      item: {
        verified: true,
        baseType: 'Bone Helmet',
        frameType: 2,
        league: 'Fixture League',
        ilvl: 75,
        influences: {},
        fractured: false,
        implicitMods:
          implicitValue === null
            ? []
            : [`Minions deal ${implicitValue}% increased Damage`],
        explicitMods:
          implicitValue === null ? ['Minions deal 18% increased Damage'] : [],
      },
    });
    const now = new Date('2026-11-03T00:00:00.000Z');
    const snapshot = createImportedMarketSnapshot(
      {
        targetId: target.id,
        capturedAt: now.toISOString(),
        sourceUrl: 'https://example.com/fixture',
        currency: 'chaos',
        dataKind: 'demo',
        listings: [15, 14, null].map((value) =>
          normalizeTradeCompatibleListing(raw(value), target),
        ),
      },
      target,
      now,
    );
    const rows = analyzeBeltSnapshot(target, snapshot, now.getTime()).rows;
    expect(rows[0]?.status, JSON.stringify(rows)).toBe('MATCH');
    expect(rows[1]?.status).toBe('REJECT');
    expect(rows[2]?.status).not.toBe('MATCH');
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
          '17% increased Attack Speed',
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
