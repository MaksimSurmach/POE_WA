import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  RegisteredTradeQueryGenerator,
  clusterJewelVariantFilter,
  noVariantFilter,
  mappedTargetFilter,
  splitNativeTradeFilters,
  validateRecipeDocument,
  type CanonicalRecipe,
} from '@poe-worksmith/domain';
import {
  canonicalRecipeFixture,
  fixtureRecipe,
} from '@poe-worksmith/domain/fixtures';
import { loadAndValidateTradeMappingManifest } from './tradeMappings.js';
import {
  generateRecipeMarketQuery,
  recipeQueryTarget,
  comparableRecipeListings,
} from './recipeMarket.js';
import { generateMarketTradeQuery } from './marketTradeQuery.js';
import { normalizeTradeCompatibleListing } from './providers/tradeCompatible.js';
import { tradeStatMappings } from './tradeStatMappings.js';

const root = new URL('../../../', import.meta.url);
const identities = z
  .object({
    stats: z.array(z.object({ id: z.string() }).passthrough()),
    bases: z.array(z.object({ type: z.string() }).passthrough()),
    resources: z.array(z.object({ name: z.string() }).passthrough()),
  })
  .parse(
    JSON.parse(
      await readFile(
        new URL(
          'docs/evidence/recipe-catalog-2026-11-03/trade-identities.json',
          root,
        ),
        'utf8',
      ),
    ),
  );
const manifest = await loadAndValidateTradeMappingManifest(
  fileURLToPath(
    new URL(
      '../mappings/poe-trade/3.29.3.3/recipe-catalog.json',
      import.meta.url,
    ),
  ),
  async (url) =>
    Response.json({
      result: [
        {
          entries: String(url).endsWith('/stats')
            ? identities.stats
            : [
                ...identities.bases,
                ...identities.resources.map((r) => ({
                  type: r.name,
                })),
              ],
        },
      ],
    }),
);
const trade = new RegisteredTradeQueryGenerator(
  {
    async resolveBase({ baseId }) {
      const m = manifest.mappings.find(
        (m) => m.entityKind === 'base' && m.canonicalId === baseId,
      );
      if (!m) throw new Error('Missing fixture base mapping');
      return {
        ok: true,
        diagnostics: [],
        value: {
          id: m.externalId,
          mappingVersion: 'fixture',
          filters: z
            .record(z.string(), z.json())
            .parse(m.payload?.filters ?? {}),
        },
      };
    },
    async resolveTarget({ target }) {
      const m = manifest.mappings.find(
        (m) => m.entityKind === 'mod' && m.canonicalId === target.modId,
      );
      if (!m) throw new Error('Missing fixture modifier mapping');
      return { ok: true, diagnostics: [], value: { id: m.externalId } };
    },
  },
  [noVariantFilter, clusterJewelVariantFilter],
  [mappedTargetFilter],
);

const at = new Date('2026-11-03T12:00:00Z');
const body = {
  ...canonicalRecipeFixture.base,
  baseId: 'base:twilight-regalia-six-link',
  itemLevel: 86,
  variant: { kind: 'none' as const },
};
const recipe = fixtureRecipe({
  ...canonicalRecipeFixture,
  base: body,
  startingBase: body,
  target: {
    prefixes: [
      { kind: 'explicit', modId: 'mod:flat-energy-shield', minimumValue: 88 },
    ],
    suffixes: [],
    implicits: [],
    other: [
      { kind: 'pseudo', modId: 'mod:item-energy-shield', minimumValue: 940 },
    ],
  },
});

describe('native item property queries', () => {
  it('rejects affix-tier requirements on displayed item properties', async () => {
    const invalid = fixtureRecipe({
      ...recipe,
      target: {
        ...recipe.target,
        other: [
          {
            kind: 'pseudo',
            modId: 'mod:item-energy-shield',
            minimumValue: 940,
            exactTier: 1,
          },
        ],
      },
    });
    await expect(
      generateRecipeMarketQuery(trade, invalid, 'Fixture League'),
    ).rejects.toThrow('TRADE_NATIVE_FILTER_INVALID');
  });
  it('keeps exact acquisition level, quality, six links and base percentile in both generated requests', async () => {
    for (const starting of [true, false]) {
      const generated = await generateRecipeMarketQuery(
        trade,
        recipe,
        'Fixture League',
        starting,
      );
      const target = recipeQueryTarget(generated.query.handbookTarget);
      const actual = generateMarketTradeQuery(target).request.query;
      const expected = {
        armour_filters: {
          filters: {
            base_defence_percentile: { min: 100, max: 100 },
            ...(starting ? {} : { es: { min: 940 } }),
          },
        },
        socket_filters: { filters: { links: { min: 6, max: 6 } } },
        misc_filters: {
          filters: {
            ilvl: { min: 86, ...(starting ? { max: 86 } : {}) },
            quality: { min: 20, max: 20 },
          },
        },
      };
      expect(generated.query.query).toMatchObject({
        filters: expected,
        stats: starting
          ? []
          : [
              {
                type: 'and',
                filters: [
                  { id: 'explicit.stat_4052037485', value: { min: 88 } },
                ],
              },
            ],
      });
      expect(actual).toMatchObject({ filters: expected });
      expect(
        actual.stats
          .flatMap((g) => g.filters)
          .some((s) =>
            [
              'armour.es',
              'socket.links',
              'misc.quality',
              'misc.base_defence_percentile',
            ].includes(s.id),
          ),
      ).toBe(false);
    }
  });

  it.each([
    ['valid', 940, 20, 6, 100, true],
    ['legacy percentile', 940, 20, 6, 100, true],
    ['conflicting percentile', 940, 20, 6, 100, false],
    ['under flat ES', 940, 20, 6, 100, false],
    ['under ES', 939, 20, 6, 100, false],
    ['under quality', 940, 19, 6, 100, false],
    ['five links', 940, 20, 5, 100, false],
    ['nonperfect base', 940, 20, 6, 99, false],
    ['missing ES', null, 20, 6, 100, false],
    ['missing quality', 940, null, 6, 100, false],
    ['missing links', 940, 20, null, 100, false],
    ['missing base percentile', 940, 20, 6, null, false],
  ] as const)(
    'matches actual displayed properties and fails closed: %s',
    async (_label, es, quality, links, percentile, expected) => {
      const query = await generateRecipeMarketQuery(
        trade,
        recipe,
        'Fixture League',
      );
      const target = recipeQueryTarget(query.query.handbookTarget);
      const raw = {
        id: 'fixture-item',
        listing: {
          indexed: at.toISOString(),
          price: { amount: 10, currency: 'chaos' },
          account: { name: 'fixture-seller' },
        },
        item: {
          verified: true,
          baseType: 'Twilight Regalia',
          league: 'Fixture League',
          frameType: 2,
          ilvl: 86,
          influences: {},
          explicitMods: [
            `+${_label === 'under flat ES' ? 87 : 88} to maximum Energy Shield`,
          ],
          ...(percentile === null
            ? {}
            : _label === 'legacy percentile'
              ? { baseDefencePercentile: percentile }
              : {
                  extended: { base_defence_percentile: percentile },
                  ...(_label === 'conflicting percentile'
                    ? { baseDefencePercentile: 99 }
                    : {}),
                }),
          ...(links === null
            ? {}
            : {
                sockets: Array.from({ length: 6 }, (_, i) => ({
                  group: i < links ? 0 : 1,
                })),
              }),
          properties: [
            ...(es === null
              ? []
              : [
                  {
                    name: 'Energy Shield',
                    type: 18,
                    values: [[String(es), 0]],
                  },
                ]),
            ...(quality === null
              ? []
              : [{ name: 'Quality', type: 6, values: [[`+${quality}%`, 0]] }]),
          ],
        },
      };
      const normalized = normalizeTradeCompatibleListing(raw, target);
      const comparable = comparableRecipeListings(
        query.query,
        [
          {
            id: raw.id,
            account: 'fixture-seller',
            ageSeconds: 0,
            indexedAt: at,
            fee: null,
            price: { amount: '10', currency: 'chaos' },
            item: { ...normalized.item, rawListing: raw },
          },
        ],
        at,
        at,
      );
      expect(comparable.length).toBe(expected ? 1 : 0);
    },
  );

  it.each([
    { type: 'or', filters: [{ id: 'armour.es', value: { min: 900 } }] },
    { type: 'and', filters: [{ id: 'socket.links', value: { min: 7 } }] },
    { type: 'and', filters: [{ id: 'misc.quality', value: { min: -1 } }] },
    {
      type: 'and',
      filters: [{ id: 'misc.base_defence_percentile', value: { min: 101 } }],
    },
    {
      type: 'and',
      filters: [{ id: 'armour.es', disabled: true, value: { min: 900 } }],
    },
  ])('rejects unsupported native semantics before HTTP: %j', (group) => {
    expect(() => splitNativeTradeFilters([group])).toThrow(
      'TRADE_NATIVE_FILTER_INVALID',
    );
  });
});

const targets = z
  .object({
    targets: z.array(
      z.object({
        id: z.string(),
        baseId: z.string(),
        smallPassiveStatId: z.string(),
        notables: z.array(z.object({ modId: z.string(), name: z.string() })),
      }),
    ),
  })
  .parse(
    JSON.parse(
      await readFile(
        new URL(
          'docs/evidence/craft-profit-2026-11-03/cluster-targets.json',
          root,
        ),
        'utf8',
      ),
    ),
  ).targets;
const options: Record<string, number> = {
  'bow-damage': 4,
  'cold-damage': 15,
  'shield-attack-damage': 8,
  'chaos-damage': 16,
  'two-handed-damage': 6,
  'fire-damage': 13,
};

describe('exact cluster alias queries', () => {
  it.each(targets)(
    'does not mix $id with the existing physical market',
    async (target) => {
      const base: CanonicalRecipe['base'] = {
        ...canonicalRecipeFixture.base,
        baseId: target.baseId,
        itemLevel: 68,
        variant: {
          kind: 'cluster-jewel',
          passiveCount: 8,
          smallPassiveStatId: target.smallPassiveStatId,
        },
      };
      const recipe = fixtureRecipe({
        ...canonicalRecipeFixture,
        base,
        startingBase: base,
        target: {
          prefixes: target.notables.map((n) => ({
            kind: 'explicit' as const,
            modId: n.modId,
            minimumValue: 1,
          })),
          suffixes: [],
          implicits: [],
          other: [],
        },
      });
      const generated = await generateRecipeMarketQuery(
        trade,
        recipe,
        'Fixture League',
      );
      const marketTarget = recipeQueryTarget(generated.query.handbookTarget);
      const actual = generateMarketTradeQuery(marketTarget).request.query;
      const filters = actual.stats.flatMap((g) => g.filters);
      expect(filters).toContainEqual({
        id: 'enchant.stat_3086156145',
        value: { min: 8, max: 8 },
      });
      expect(filters).toContainEqual({
        id: 'enchant.stat_4079888060',
        value: { min: 2, max: 2 },
      });
      expect(filters).toContainEqual({
        id: `enchant.stat_3948993189|${options[target.smallPassiveStatId]}`,
      });
      expect(filters.some((f) => f.id === 'enchant.stat_3948993189|12')).toBe(
        false,
      );
      for (const notable of target.notables) {
        const mapping = manifest.mappings.find(
          (m) => m.canonicalId === notable.modId,
        );
        expect(filters).toContainEqual({
          id: mapping?.externalId,
          value: { min: 1 },
        });
        expect(tradeStatMappings[mapping?.externalId ?? '']?.text).toBe(
          `1 Added Passive Skill is ${notable.name}`,
        );
      }
      const raw = {
        id: 'cluster-fixture',
        listing: {
          indexed: at.toISOString(),
          price: { amount: 10, currency: 'chaos' },
          account: { name: 'fixture-seller' },
        },
        item: {
          verified: true,
          baseType: 'Large Cluster Jewel',
          league: 'Fixture League',
          frameType: 2,
          ilvl: 68,
          influences: {},
          explicitMods: target.notables.map(
            (n) => `1 Added Passive Skill is ${n.name}`,
          ),
          enchantMods: [
            'Adds 8 Passive Skills',
            tradeStatMappings[
              `enchant.stat_3948993189|${options[target.smallPassiveStatId]}`
            ]?.text ?? '',
            '2 Added Passive Skills are Jewel Sockets',
          ],
        },
      };
      const match = () => {
        const normalized = normalizeTradeCompatibleListing(raw, marketTarget);
        return comparableRecipeListings(
          generated.query,
          [
            {
              id: raw.id,
              account: 'fixture-seller',
              ageSeconds: 0,
              indexedAt: at,
              fee: null,
              price: { amount: '10', currency: 'chaos' },
              item: { ...normalized.item, rawListing: raw },
            },
          ],
          at,
          at,
        );
      };
      expect(match()).toHaveLength(1);
      raw.item.enchantMods[1] =
        'Added Small Passive Skills grant: 12% increased Physical Damage';
      expect(match()).toHaveLength(0);
    },
  );
});

describe('Convoking Wand crafted trigger evidence', () => {
  const trigger =
    'Trigger a Socketed Spell when you Use a Skill, with a 8 second Cooldown\nSpells Triggered this way have 150% more Cost';
  it.each([
    'literal8s',
    'official100',
    'fourSeconds',
    'wrongOrigin',
    'wrongHash',
    'official80',
  ] as const)(
    'checks the exact crafted origin, cooldown and guaranteed chance: %s',
    async (mode) => {
      const definition = validateRecipeDocument(
        JSON.parse(
          await readFile(
            new URL(
              'recipes/wand/minion-convoking-wand-fear-trigger.json',
              root,
            ),
            'utf8',
          ),
        ),
      );
      const query = await generateRecipeMarketQuery(
        trade,
        definition,
        'Fixture League',
      );
      const target = recipeQueryTarget(query.query.handbookTarget);
      const triggerMapping = tradeStatMappings['crafted.stat_3079007202'];
      if (!triggerMapping) throw new Error('Missing trigger fixture mapping');
      const description =
        mode === 'fourSeconds'
          ? trigger.replace('8 second', '4 second')
          : mode === 'official100' || mode === 'official80'
            ? triggerMapping.text.replace(
                '#',
                mode === 'official100' ? '100' : '80',
              )
            : trigger;
      const raw = {
        id: 'wand-fixture',
        listing: {
          indexed: at.toISOString(),
          price: { amount: 10, currency: 'chaos' },
          account: { name: 'fixture-seller' },
        },
        item: {
          verified: true,
          baseType: 'Convoking Wand',
          league: 'Fixture League',
          frameType: 2,
          ilvl: 83,
          influences: {},
          explicitMods: [
            '+1 to Level of all Minion Skill Gems',
            'Minions deal 83% increased Damage',
            ...(mode === 'wrongOrigin' ? [description] : []),
          ],
          fracturedMods: ['Minions have 20% increased Attack and Cast Speed'],
          craftedMods:
            mode === 'wrongOrigin'
              ? []
              : mode === 'wrongHash'
                ? [
                    {
                      domain: 'crafted',
                      hash: 'stat.crafted.stat_999999999',
                      description,
                    },
                  ]
                : [description],
        },
      };
      const normalized = normalizeTradeCompatibleListing(raw, target);
      const comparable = comparableRecipeListings(
        query.query,
        [
          {
            id: raw.id,
            account: 'fixture-seller',
            ageSeconds: 0,
            indexedAt: at,
            fee: null,
            price: { amount: '10', currency: 'chaos' },
            item: { ...normalized.item, rawListing: raw },
          },
        ],
        at,
        at,
      );
      expect(comparable).toHaveLength(
        ['literal8s', 'official100'].includes(mode) ? 1 : 0,
      );
    },
  );
});
