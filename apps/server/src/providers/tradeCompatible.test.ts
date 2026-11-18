import type { CanonicalJsonValue } from '@poe-worksmith/domain';
import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { marketListingFixture } from '../marketListingFixture.js';
import {
  createMarketTarget,
  createImportedMarketSnapshot,
} from '../marketResearch.js';
import {
  comparableRecipeListings,
  recipeQueryTarget,
} from '../recipeMarket.js';
import {
  analyzeListingComparability,
  compareListingItems,
} from '../listingComparability.js';
import { generateMarketTradeQuery } from '../marketTradeQuery.js';
import {
  TradeCompatibleTransport,
  loadTradeCompatibleConfig,
  normalizeTradeCompatibleListing,
} from './tradeCompatible.js';
import { createBatchedMarketCollectionSource } from '../marketCollection.js';

const at = new Date('2026-11-01T12:00:00.000Z');
export function tradeTarget() {
  return createMarketTarget(
    {
      ...marketListingFixture(at).target,
      tradeSearch: {
        version: 1,
        scope: 'strict',
        status: 'available',
        currency: 'chaos',
        rarity: 'rare',
        groups: [
          {
            type: 'and',
            filters: [{ id: 'explicit.stat_3299347043', key: 'life', min: 80 }],
          },
        ],
      },
    },
    at,
  );
}
// Synthetic endpoint-format fixture, based on the recorded manual life roll. Not a live API capture.
export function rawTradeListing(id = 'listing-1', life = 90) {
  return {
    id,
    listing: {
      indexed: at.toISOString(),
      price: { amount: 40, currency: 'chaos' },
      account: { name: `seller-${id}` },
    },
    item: {
      baseType: 'Stygian Vise',
      frameType: 2,
      league: 'Demo',
      ilvl: 84,
      corrupted: false,
      influences: {},
      explicitMods: [`+${life} to maximum Life`],
      implicitMods: ['Has 1 Abyssal Socket'],
      extended: {
        hashes: { explicit: [['explicit.stat_3299347043', [0]]] },
        mods: {
          explicit: [
            {
              tier: 'P2',
              magnitudes: [
                { hash: 'explicit.stat_3299347043', min: 80, max: 99 },
              ],
            },
          ],
        },
      },
    },
  };
}
const config = loadTradeCompatibleConfig({
  POE_TRADE_USER_AGENT: 'Worksmith beta test',
  POE_TRADE_SESSION_ID: 'private-session',
});

describe('Trade-compatible queries and transport', () => {
  it('enforces the exact model item level in the live request and rejects an empty range', () => {
    const target = { ...tradeTarget(), minItemLevel: 84, maxItemLevel: 84 };
    expect(
      generateMarketTradeQuery(target).request.query.filters.misc_filters
        .filters.ilvl,
    ).toEqual({ min: 84, max: 84 });
    expect(() =>
      generateMarketTradeQuery({
        ...target,
        minItemLevel: 82,
        maxItemLevel: 83,
      }),
    ).toThrow('The market query is invalid.');
  });

  it('normalizes an observed cluster enum hash with null magnitude indexes', async () => {
    const raw = JSON.parse(
      await readFile(
        new URL(
          './fixtures/tradeCompatible/fetch.cluster-modern.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const row = normalizeTradeCompatibleListing(raw.result[0], tradeTarget());
    expect(row.item.mods).toContainEqual({
      id: 'enchant.stat_3948993189|12',
      value: 1,
    });
    expect(row.item.mods).toContainEqual({
      id: 'explicit.stat_4188581520',
      value: 1,
      tier: 1,
    });
    expect(row.item.mods).toContainEqual({
      id: 'explicit.stat_3415827027',
      value: 1,
      tier: 1,
    });
    expect(row.item.mods).toContainEqual({
      id: 'explicit.stat_3585232432',
      value: 1,
      tier: 1,
    });
    expect(row.rawListing).toEqual(raw.result[0]);
  });

  it('reads Trade display labels in string modifiers without rewriting raw evidence', async () => {
    const raw = JSON.parse(
      await readFile(
        new URL(
          './fixtures/tradeCompatible/fetch.cluster-modern.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ).result[0];
    raw.item.explicitMods = raw.item.explicitMods.map(
      (mod: { description: string }) => mod.description,
    );
    const before = structuredClone(raw);
    const row = normalizeTradeCompatibleListing(raw, tradeTarget());
    for (const id of [
      'explicit.stat_4188581520',
      'explicit.stat_3415827027',
      'explicit.stat_3585232432',
    ]) {
      expect(row.item.mods).toEqual(
        expect.arrayContaining([expect.objectContaining({ id, value: 1 })]),
      );
    }
    expect(raw).toEqual(before);
    expect(row.rawListing).toEqual(before);
    expect(row.item.modsComplete).toBe(false);
  });

  it('keeps malformed labels, wrong hashes and wrong origins unknown', async () => {
    const raw = JSON.parse(
      await readFile(
        new URL(
          './fixtures/tradeCompatible/fetch.cluster-modern.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ).result[0];
    const original = raw.item.explicitMods.find(
      (mod: { hash: string }) => mod.hash === 'stat.explicit.stat_4188581520',
    );
    for (const change of [
      { description: '1 Added Passive Skill is [id|]' },
      { description: '1 Added Passive Skill is [id|a|Battle-Hardened]' },
      {
        description: '1 Added Passive Skill is [outer|[inner|Battle-Hardened]]',
      },
      { description: '1 Added Passive Skill is [id|Battle-Hardened' },
      { hash: 'stat.explicit.stat_3415827027' },
      { domain: 'crafted' },
    ]) {
      const candidate = structuredClone(raw);
      candidate.item.explicitMods = [{ ...original, ...change }];
      const before = structuredClone(candidate);
      const row = normalizeTradeCompatibleListing(candidate, tradeTarget());
      expect(row.item.mods).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'explicit.stat_4188581520' }),
        ]),
      );
      expect(candidate).toEqual(before);
    }
  });

  it('omits a currency restriction when comparing converted mixed-currency asks', () => {
    const target = tradeTarget();
    const request = generateMarketTradeQuery({
      ...target,
      tradeSearch: { ...target.tradeSearch!, includeOtherCurrencies: true },
    }).request;
    expect(request.query.filters.trade_filters.filters.price).toEqual({});
    expect(
      generateMarketTradeQuery(target).request.query.filters.trade_filters
        .filters.price,
    ).toEqual({ option: 'chaos' });
  });

  it('recognizes the single-socket wording without accepting the wrong origin', () => {
    const raw = {
      ...rawTradeListing(),
      item: {
        ...rawTradeListing().item,
        enchantMods: [
          {
            domain: 'enchant',
            hash: 'stat.enchant.stat_4079888060',
            description: '1 Added Passive Skill is a Jewel Socket',
          },
        ],
      },
    };
    expect(
      normalizeTradeCompatibleListing(raw, tradeTarget()).item.mods,
    ).toEqual(
      expect.arrayContaining([{ id: 'enchant.stat_4079888060', value: 1 }]),
    );
    raw.item.enchantMods[0]!.domain = 'explicit';
    expect(
      normalizeTradeCompatibleListing(raw, tradeTarget()).item.mods,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'enchant.stat_4079888060' }),
      ]),
    );
  });

  it('totals output contributions without borrowing a tier or changing starting-base requirements', () => {
    const raw = {
      ...rawTradeListing(),
      item: {
        ...rawTradeListing().item,
        explicitMods: [
          {
            domain: 'explicit',
            hash: 'stat.explicit.stat_3299347043',
            description: '+35 to maximum Life',
            mods: [{ tier: 'P2' }],
          },
        ],
        fracturedMods: [
          {
            domain: 'fractured',
            hash: 'stat.fractured.stat_3299347043',
            description: '+25 to maximum Life',
            mods: [{ tier: 'P1' }],
          },
        ],
        craftedMods: ['+30 to maximum Life'],
      },
    };
    const output = normalizeTradeCompatibleListing(raw, {
      ...tradeTarget(),
      slot: 'crafted-item',
    });
    expect(output.item.mods).toEqual(
      expect.arrayContaining([
        { id: 'explicit.stat_3299347043', value: 90 },
        { id: 'fractured.stat_3299347043', value: 25, tier: 1 },
      ]),
    );
    const base = normalizeTradeCompatibleListing(raw, {
      ...tradeTarget(),
      slot: 'starting-base',
    });
    expect(base.item.mods).toEqual(
      expect.arrayContaining([
        { id: 'explicit.stat_3299347043', value: 35, tier: 2 },
      ]),
    );
    expect(output.rawListing).toEqual(raw);
  });

  it('recognizes observed support effect hashes without declaring the requested support absent', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          './fixtures/tradeCompatible/fetch.support-physical-modern.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    for (const { item, expected } of fixture.supports) {
      const target = tradeTarget();
      target.tradeSearch!.groups[0]!.filters = [
        { id: expected.id, min: expected.value },
      ];
      const raw = { ...rawTradeListing(), item };
      const row = normalizeTradeCompatibleListing(raw, target);
      expect(row.item.mods).toContainEqual(expected);
      expect(row.item.verifiedAbsentStats).not.toContain(expected.id);
      expect(row.rawListing).toEqual(raw);
      const mod = item.explicitMods[0];
      const label =
        expected.id === 'explicit.indexable_support_68'
          ? 'Burning Damage'
          : 'Concentrated Effect';
      const legacy = {
        ...mod,
        hash: `stat.${expected.id}`,
        description: `Socketed Gems are Supported by Level ${expected.value} ${label}`,
      };
      expect(
        normalizeTradeCompatibleListing(
          { ...raw, item: { ...item, explicitMods: [legacy] } },
          target,
        ).item.mods,
      ).toContainEqual(expected);
      expect(
        normalizeTradeCompatibleListing(
          {
            ...raw,
            item: {
              ...item,
              explicitMods: [],
              extended: { hashes: { explicit: [] } },
            },
          },
          target,
        ).item.verifiedAbsentStats,
      ).toContain(expected.id);
      expect(
        normalizeTradeCompatibleListing(
          {
            ...raw,
            item: {
              ...item,
              explicitMods: [{ ...mod, mods: [] }],
              extended: {
                hashes: {
                  explicit: [
                    [expected.id, [0]],
                    [mod.hash.replace(/^stat\./, ''), [1]],
                  ],
                },
                mods: { explicit: [{ tier: 'P9' }, ...mod.mods] },
              },
            },
          },
          target,
        ).item.mods,
      ).toContainEqual(expected);
      for (const rejected of [
        { ...mod, hash: 'stat.explicit.effect_1' },
        { ...mod, domain: 'crafted' },
        { ...mod, description: mod.description.replace('|', '|Awakened ') },
        { ...mod, description: `${mod.description} while Shapeshifted` },
      ]) {
        expect(
          normalizeTradeCompatibleListing(
            { ...raw, item: { ...item, explicitMods: [rejected] } },
            target,
          ).item.mods,
        ).not.toContainEqual(expect.objectContaining({ id: expected.id }));
      }
    }
  });

  it('includes observed crafted physical damage in output totals while preserving base origins', async () => {
    const { physical: item } = JSON.parse(
      await readFile(
        new URL(
          './fixtures/tradeCompatible/fetch.support-physical-modern.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const raw = { ...rawTradeListing(), item };
    expect(
      normalizeTradeCompatibleListing(raw, {
        ...tradeTarget(),
        slot: 'crafted-item',
      }).item.mods,
    ).toContainEqual({ id: 'explicit.stat_1509134228', value: 130 });
    expect(
      normalizeTradeCompatibleListing(raw, {
        ...tradeTarget(),
        slot: 'starting-base',
      }).item.mods,
    ).toContainEqual({ id: 'explicit.stat_1509134228', value: 50, tier: 4 });
    const crafted = item.explicitMods.find(
      (mod: { domain: string }) => mod.domain === 'crafted',
    );
    expect(
      normalizeTradeCompatibleListing(
        {
          ...raw,
          item: {
            ...item,
            explicitMods: [
              { ...crafted, description: '118% increased Physical Damage' },
            ],
          },
        },
        { ...tradeTarget(), slot: 'crafted-item' },
      ).item.mods,
    ).toContainEqual({ id: 'explicit.stat_1509134228', value: 118 });
  });

  it.each([0, 1, 2, 3])(
    'recognizes the observed fractured local modifier in item %i',
    async (index) => {
      const { fixtures } = JSON.parse(
        await readFile(
          new URL(
            './fixtures/tradeCompatible/fetch.fractured-local-modern.json',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      expect(fixtures).toHaveLength(4);
      const fixture = fixtures[index];
      const target = recipeQueryTarget(JSON.stringify(fixture.handbookTarget));
      const envelope = rawTradeListing('redacted-fractured-fixture');
      const raw = {
        ...envelope,
        item: fixture.item,
        listing: { ...envelope.listing, price: fixture.originalPrice },
      };
      const row = normalizeTradeCompatibleListing(raw, target);
      expect(row.item.mods).toContainEqual(fixture.expectedCanonicalModifier);
      expect(
        compareListingItems(target, {
          currency: fixture.originalPrice.currency,
          listings: [{ ...row, currency: fixture.originalPrice.currency }],
        })[0]?.status,
      ).toBe('MATCH');
      if (index === 0) {
        const base = normalizeTradeCompatibleListing(raw, {
          ...target,
          slot: 'starting-base',
        });
        expect(base.item.mods).toContainEqual({
          id: 'explicit.stat_1509134228',
          value: 47,
          tier: 4,
        });
        expect(base.item.mods).not.toContainEqual(
          expect.objectContaining({
            id: 'explicit.stat_1509134228',
            value: 207,
          }),
        );
      }
    },
  );

  it.each([
    ['fetch.fractured-movement-modern.json', 'stat_2250533757', 25],
    ['fetch.fractured-bow-gems-modern.json', 'stat_2027269580', 2],
  ])(
    'maps the actual modern fractured origin from %s',
    async (file, statId, value) => {
      const fixture = JSON.parse(
        await readFile(
          new URL(`./fixtures/tradeCompatible/${file}`, import.meta.url),
          'utf8',
        ),
      );
      const target = recipeQueryTarget(JSON.stringify(fixture.handbookTarget));
      const raw = {
        ...rawTradeListing('redacted-fractured-fixture'),
        item: fixture.item,
      };
      const row = normalizeTradeCompatibleListing(raw, target);
      expect(row.item.mods).toContainEqual({
        id: `explicit.${statId}`,
        value,
        tier: 1,
      });
      expect(
        compareListingItems(target, {
          currency: 'chaos',
          listings: [{ ...row, currency: 'chaos' }],
        })[0]?.status,
      ).toBe('MATCH');

      const base = normalizeTradeCompatibleListing(raw, {
        ...target,
        slot: 'starting-base',
      });
      expect(base.item.mods).toContainEqual(
        expect.objectContaining({ id: `fractured.${statId}`, value, tier: 1 }),
      );
      expect(base.item.mods).not.toContainEqual(
        expect.objectContaining({ id: `explicit.${statId}` }),
      );

      const edited = structuredClone(raw);
      const line = edited.item.explicitMods.find(
        (mod: { hash: string }) => mod.hash === `stat.fractured.${statId}`,
      );
      expect(line).toBeDefined();
      line.description = line.description.replace(
        String(value),
        String(value - 1),
      );
      expect(
        compareListingItems(target, {
          currency: 'chaos',
          listings: [
            {
              ...normalizeTradeCompatibleListing(edited, target),
              currency: 'chaos',
            },
          ],
        })[0]?.status,
      ).toBe('REJECT');
    },
  );

  it('matches the actual Prophet Crown returned by both configured Helmet searches', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          './fixtures/tradeCompatible/fetch.helmet-category-actual.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(fixture.handbookTargets).toHaveLength(2);
    // Neutral unit identity/account envelope only; actual price/currency preserved, no FX.
    const envelope = rawTradeListing('redacted-helmet-fixture');
    const raw = {
      ...envelope,
      item: fixture.item,
      listing: { ...envelope.listing, price: fixture.originalPrice },
    };
    for (const handbookTarget of fixture.handbookTargets) {
      const target = recipeQueryTarget(JSON.stringify(handbookTarget));
      const row = normalizeTradeCompatibleListing(raw, target);
      expect(row.price).toBe(fixture.originalPrice.amount);
      expect(
        compareListingItems(target, {
          currency: fixture.originalPrice.currency,
          listings: [{ ...row, currency: fixture.originalPrice.currency }],
        })[0]?.status,
      ).toBe('MATCH');
    }
  });

  it('sends the current wire IDs for the actual modern RF result and still matches it', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          './fixtures/tradeCompatible/fetch.rf-modern-query-actual.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const target = createMarketTarget(fixture.handbookTarget);
    expect(generateMarketTradeQuery(target).request).toEqual(
      fixture.modernWireRequest,
    );
    // Neutral unit identity/account envelope only; actual price/currency preserved, no FX.
    const envelope = rawTradeListing('redacted-rf-fixture');
    const raw = {
      ...envelope,
      item: fixture.item,
      listing: { ...envelope.listing, price: fixture.originalPrice },
    };
    const row = normalizeTradeCompatibleListing(raw, target);
    expect(row.price).toBe(fixture.originalPrice.amount);
    expect(
      compareListingItems(target, {
        currency: fixture.originalPrice.currency,
        listings: [{ ...row, currency: fixture.originalPrice.currency }],
      })[0]?.status,
    ).toBe('MATCH');
  });

  it('keeps support level bounds on the wire ID and rejects wire IDs as input', async () => {
    const { handbookTarget } = JSON.parse(
      await readFile(
        new URL(
          './fixtures/tradeCompatible/fetch.rf-modern-query-actual.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    handbookTarget.tradeSearch.groups[0].filters[1].min = 20;
    const filters = generateMarketTradeQuery(createMarketTarget(handbookTarget))
      .request.query.stats[0]?.filters;
    expect(filters?.[0]).toEqual({
      id: 'explicit.effect_1200122555',
      value: {},
    });
    expect(filters?.[1]).toEqual({
      id: 'explicit.effect_3293595800',
      value: { min: 20 },
    });
    handbookTarget.tradeSearch.groups[0].filters[1].id =
      'explicit.effect_3293595800';
    expect(() =>
      generateMarketTradeQuery(createMarketTarget(handbookTarget)),
    ).toThrow();
  });

  it('keeps duplicate same-origin evidence ambiguous instead of increasing its accepted value', () => {
    const target = { ...tradeTarget(), slot: 'crafted-item' };
    const raw = rawTradeListing();
    raw.item.explicitMods = ['+45 to maximum Life', '+45 to maximum Life'];
    const normalized = normalizeTradeCompatibleListing(raw, target);
    const imported = createImportedMarketSnapshot(
      {
        targetId: target.id,
        capturedAt: at.toISOString(),
        sourceUrl: 'https://www.pathofexile.com/trade',
        currency: 'chaos',
        dataKind: 'observed',
        listings: [normalized],
      },
      target,
      at,
    );
    expect(
      analyzeListingComparability(target, imported, at.getTime()).rows[0]
        ?.status,
    ).toBe('PARTIAL');
    expect(normalized.item.mods).not.toEqual(
      expect.arrayContaining([{ id: 'explicit.stat_3299347043', value: 90 }]),
    );
  });

  it('sums hybrid, all-elemental, chaos and negative resistance values, withholding incomplete totals', () => {
    const raw = rawTradeListing();
    raw.item.explicitMods = [
      '+10% to Fire and Cold Resistances',
      '+7% to Fire and Chaos Resistances',
      '+3% to all Elemental Resistances',
      '-2% to Lightning Resistance',
    ];
    const normalized = normalizeTradeCompatibleListing(raw, tradeTarget());
    expect(normalized.item.elementalResistances).toEqual({
      fire: 20,
      cold: 13,
      lightning: 1,
    });
    expect(normalized.item.mods).toEqual(
      expect.arrayContaining([
        { id: 'pseudo.pseudo_total_elemental_resistance', value: 34 },
        { id: 'pseudo.pseudo_total_resistance', value: 41 },
      ]),
    );
    raw.item.explicitMods.push('+10% to Fire Resistance while moving');
    expect(
      normalizeTradeCompatibleListing(raw, tradeTarget()).item.mods,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'pseudo.pseudo_total_resistance' }),
      ]),
    );
    Reflect.deleteProperty(raw.item, 'explicitMods');
    expect(
      normalizeTradeCompatibleListing(raw, tradeTarget()).item.mods,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'pseudo.pseudo_total_resistance' }),
      ]),
    );
  });

  it('normalizes the sanitized November 1 object-mod response and preserves crafted origin', async () => {
    const raw = JSON.parse(
      await readFile(
        new URL(
          './fixtures/tradeCompatible/fetch.modern.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { result: unknown[] };
    const row = normalizeTradeCompatibleListing(raw.result[0], tradeTarget());
    expect(row.item.corrupted).toBe(false);
    expect(row.item.fractured).toBe(false);
    expect(row.item.mods).toContainEqual({
      id: 'explicit.stat_3299347043',
      value: 128,
      tier: 2,
    });
    expect(row.item.mods).toContainEqual({
      id: 'crafted.stat_387439868',
      value: 32,
    });
    expect(row.item.mods).not.toContainEqual(
      expect.objectContaining({ id: 'explicit.stat_387439868' }),
    );
    expect(row.item.mods).toContainEqual({
      id: 'pseudo.pseudo_total_elemental_resistance',
      value: 80,
    });
    expect(row.rawListing?.item).toHaveProperty('explicitMods.0.description');
  });
  it('matches count groups, enforces actual tiers and keeps missing tier evidence partial', () => {
    const target = tradeTarget();
    const search = target.tradeSearch!;
    const grouped = {
      ...target,
      tradeSearch: {
        ...search,
        groups: [
          {
            type: 'count' as const,
            min: 1,
            filters: [
              { id: 'explicit.stat_3299347043', min: 80, maxTier: 2 },
              { id: 'explicit.stat_2923486259', min: 26 },
            ],
          },
        ],
      },
    };
    const raw = rawTradeListing();
    const status = () =>
      analyzeListingComparability(
        grouped,
        createImportedMarketSnapshot(
          {
            targetId: grouped.id,
            capturedAt: at.toISOString(),
            sourceUrl: 'https://example.com/demo',
            currency: 'chaos',
            dataKind: 'demo',
            listings: [normalizeTradeCompatibleListing(raw, grouped)],
          },
          grouped,
          at,
        ),
        at.getTime(),
      ).rows[0]?.status;
    expect(status()).toBe('MATCH');
    expect(
      generateMarketTradeQuery(grouped).request.query.stats[0],
    ).toMatchObject({ type: 'count', value: { min: 1 } });
    raw.item.extended.mods.explicit[0]!.tier = 'P3';
    expect(status()).toBe('REJECT');
    raw.item.extended.mods.explicit = [];
    expect(status()).toBe('PARTIAL');
  });

  it('bounds a timed-out request and does not retain transport error details', async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeout.signal);
    const requestSignals: AbortSignal[] = [];
    const fetcher: typeof fetch = async (_, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error('Missing request signal');
      requestSignals.push(signal);
      signal.throwIfAborted();
      return new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('private-session')),
          { once: true },
        );
      });
    };
    const transport = new TradeCompatibleTransport(
      { ...config, timeoutMs: 100 },
      { fetcher },
    );
    try {
      const request = transport.search({
        target: tradeTarget(),
        signal: new AbortController().signal,
      });
      timeout.abort();
      await expect(request).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        cause: undefined,
      });
      expect(timeoutSpy).toHaveBeenCalledWith(100);
      expect(transport.connectionStatus).toBe('UNAVAILABLE');
      expect(requestSignals[0]?.aborted).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
  it('generates deterministic strict/broad requests and rejects unknown mappings', () => {
    const target = tradeTarget();
    const strict = generateMarketTradeQuery(target);
    expect(
      generateMarketTradeQuery({ ...target, id: crypto.randomUUID() }).hash,
    ).toBe(strict.hash);
    expect(strict.request.query.type).toBe('Stygian Vise');
    expect(strict.request.query.status.option).toBe('available');
    expect(strict.request.sort.price).toBe('asc');
    const broad = generateMarketTradeQuery(target, 'broad');
    expect(broad.hash).not.toBe(strict.hash);
    expect(broad.request.query.stats[0]?.filters[0]?.value?.min).toBe(64);
    expect(() =>
      generateMarketTradeQuery({
        ...target,
        tradeSearch: {
          ...target.tradeSearch!,
          groups: [
            {
              type: 'and',
              filters: [{ id: 'explicit.not_a_mapping', min: 80 }],
            },
          ],
        },
      }),
    ).toThrow('The market query is invalid.');
    expect(() =>
      generateMarketTradeQuery({ ...target, baseTypes: ['A', 'B'] }),
    ).toThrow('The market query is invalid.');
  });

  it('normalizes actual rolls, tiers, raw observations and modifier origin', () => {
    const row = normalizeTradeCompatibleListing(
      rawTradeListing(),
      tradeTarget(),
    );
    expect(row.item.mods).toContainEqual({ id: 'life', value: 90, tier: 2 });
    expect(row.item.itemLevel).toBe(84);
    expect(
      normalizeTradeCompatibleListing(
        {
          ...rawTradeListing(),
          listing: {
            ...rawTradeListing().listing,
            fee: { amount: 4104, currency: 'gold' },
          },
        },
        tradeTarget(),
      ).fee,
    ).toBe(4104);
    expect(row.rawListing?.item).toHaveProperty(
      'extended.mods.explicit.0.magnitudes',
    );
    const malformed = rawTradeListing();
    malformed.item.extended.mods.explicit[0]!.tier = 'S0';
    expect(
      normalizeTradeCompatibleListing(malformed, tradeTarget()).item.mods,
    ).toContainEqual({ id: 'explicit.stat_3299347043', value: 90 });
    malformed.item.explicitMods = ['unexpected life format'];
    expect(
      normalizeTradeCompatibleListing(
        { ...malformed, item: { ...malformed.item, verified: true } },
        tradeTarget(),
      ).item.verifiedAbsentStats,
    ).not.toContain('explicit.stat_3299347043');
    expect(
      normalizeTradeCompatibleListing(malformed, tradeTarget()).item.mods,
    ).not.toContainEqual(expect.objectContaining({ id: 'life' }));
    expect(
      normalizeTradeCompatibleListing(
        { ...rawTradeListing(), listing: { account: { name: 'seller' } } },
        tradeTarget(),
      ).price,
    ).toBeNull();
  });

  it('uses POST search and batches of ten through the existing collection adapter', async () => {
    const ids = Array.from({ length: 13 }, (_, i) => `listing-${i}`);
    const queryId = 'H4sI' + 'a'.repeat(304);
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.headers).toMatchObject({
        Cookie: 'POESESSID=private-session',
      });
      if (String(url).includes('/search/'))
        return Response.json({ id: queryId, total: 13, result: ids });
      expect(new URL(String(url)).searchParams.get('query')).toBe(queryId);
      const batch =
        new URL(String(url)).pathname.split('/').at(-1)?.split(',') ?? [];
      return Response.json({ result: batch.map((id) => rawTradeListing(id)) });
    });
    const transport = new TradeCompatibleTransport(config, {
      fetcher,
      clock: () => at,
    });
    const source = createBatchedMarketCollectionSource({
      descriptor: {
        id: 'test',
        name: 'Synthetic',
        access: 'replay',
        dataKind: 'demo',
        reason: null,
      },
      transport,
      rateLimits: {
        waitForPermit: vi.fn(),
        observeResponse: vi.fn(),
      },
    });
    const batch = await source.collect({
      target: tradeTarget(),
      signal: new AbortController().signal,
    });
    expect(batch).toMatchObject({
      coverage: 'complete',
      fetchedCount: 13,
      batchCount: 2,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(transport.connectionStatus).toBe('CONNECTED');
    expect(JSON.stringify(batch)).not.toContain('private-session');
  });

  it.each([
    [401, 'AUTH_REQUIRED'],
    [403, 'ACCESS_DENIED'],
    [429, 'RATE_LIMITED'],
    [503, 'UNAVAILABLE'],
  ] as const)('reports HTTP %s safely', async (status, expected) => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response('private-session', {
          status,
          headers: { 'Retry-After': '7' },
        }),
    );
    const transport = new TradeCompatibleTransport(config, { fetcher });
    const response = await transport.search({
      target: tradeTarget(),
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(status);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(transport.connectionStatus).toBe(expected);
    if (status === 401 || status === 403) {
      await expect(
        transport.search({
          target: tradeTarget(),
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'MARKET_ACCESS_BLOCKED' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('retains cached capture time and redacts reflected credentials', async () => {
    let now = at;
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: 'query-1',
        total: 0,
        result: [],
        cookie: 'secret',
        reflected: 'private-session',
      }),
    );
    const transport = new TradeCompatibleTransport(config, {
      fetcher,
      clock: () => now,
    });
    const first = await transport.search({
      target: tradeTarget(),
      signal: new AbortController().signal,
    });
    now = new Date(at.getTime() + 1000);
    const second = await transport.search({
      target: tradeTarget(),
      signal: new AbortController().signal,
    });
    expect(second.cached).toBe(true);
    expect(second.data.capturedAt).toBe(first.data.capturedAt);
    expect(second.data.raw).toMatchObject({
      cookie: '[REDACTED]',
      reflected: '[REDACTED]',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fails closed on redirects, challenges and changed schemas', async () => {
    for (const response of [
      new Response(null, {
        status: 302,
        headers: { Location: 'https://example.com/' },
      }),
      new Response('challenge', { headers: { 'cf-mitigated': 'challenge' } }),
    ]) {
      const transport = new TradeCompatibleTransport(config, {
        fetcher: async (_, init) => {
          expect(init?.redirect).toBe('manual');
          return response;
        },
      });
      expect(
        (
          await transport.search({
            target: tradeTarget(),
            signal: new AbortController().signal,
          })
        ).status,
      ).toBe(403);
      expect(transport.connectionStatus).toBe('ACCESS_DENIED');
    }
    const transport = new TradeCompatibleTransport(config, {
      fetcher: async () => Response.json({ changed: true }),
    });
    await expect(
      transport.search({
        target: tradeTarget(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
  });

  it('never leaks invalid session values in configuration errors', () => {
    expect(() =>
      loadTradeCompatibleConfig({
        POE_TRADE_USER_AGENT: 'app-test',
        POE_TRADE_SESSION_ID: 'secret\nvalue',
      }),
    ).toThrow('Invalid Trade environment');
    expect(() =>
      loadTradeCompatibleConfig({
        POE_TRADE_USER_AGENT: 'app-test',
        POE_TRADE_BASE_URL: 'https://secret:password@example.com',
      }),
    ).toThrow('HTTPS origin without credentials');
  });
});

it('derives absent influences from full normal Trade items and revalidates historical raw observations', async () => {
  const capture = JSON.parse(
    await readFile(
      new URL(
        './fixtures/tradeCompatible/fetch.normal-cluster.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const target = createMarketTarget(capture.target);
  const normalized = normalizeTradeCompatibleListing(capture.result[0], target);
  expect(normalized.item.influences).toEqual([]);
  const legacyItem: Record<string, CanonicalJsonValue> = {
    ...normalized.item,
    normalizationVersion: 'trade-compatible-v2',
    rawListing: capture.result[0],
  };
  delete legacyItem.influences;
  const capturedAt = new Date('2026-11-02T15:10:53Z');
  const matches = comparableRecipeListings(
    { handbookTarget: JSON.stringify(capture.target) },
    [
      {
        id: 'normal-cluster-sanitized',
        account: 'sanitized-seller',
        ageSeconds: 0,
        indexedAt: capturedAt,
        fee: null,
        item: legacyItem,
        price: { amount: '9', currency: 'chaos' },
      },
    ],
    capturedAt,
    capturedAt,
  );
  expect(matches).toHaveLength(1);
  expect(matches[0]?.item.influences).toEqual([]);
  expect(matches[0]?.price).toEqual({ amount: '9', currency: 'chaos' });
  expect(legacyItem).not.toHaveProperty('influences');
});
