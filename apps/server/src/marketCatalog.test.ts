import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { marketListingFixture } from './marketListingFixture.js';
import {
  activeCatalogTargets,
  importMarketCatalog,
  marketCatalogImportSchema,
} from './marketCatalog.js';
import type { MarketTarget } from '@poe-worksmith/contracts';

describe('versioned JSON catalog', () => {
  it('keeps checked CoE support and recovery requirements rather than the stale unrelated IDs', async () => {
    const catalog = marketCatalogImportSchema.parse(
      JSON.parse(
        await readFile(
          new URL('../../../catalog/market-beta-3.29.json', import.meta.url),
          'utf8',
        ),
      ),
    );
    const requirements = (url: string) =>
      JSON.parse(
        Buffer.from(new URL(url).searchParams.get('reqs')!, 'base64').toString(
          'utf8',
        ),
      ) as Array<{ e: Array<{ i: string; t: string | null }> }>;
    const rf = catalog.profiles.find(
      (profile) => profile.catalog.key === 'rf-fire-trap-helmet',
    )!;
    expect(
      requirements(rf.craftVariants![0]!.craftOfExileUrl)[0]!.e.map(
        (entry) => entry.i,
      ),
    ).toEqual(['2840', '2845', 'special:open-prefix']);
    expect(
      requirements(rf.craftVariants![1]!.craftOfExileUrl)[0]!.e.every(
        (entry) => entry.t === '1',
      ),
    ).toBe(true);
    const shield = catalog.profiles.find(
      (profile) => profile.catalog.key === 'lacerate-block-shield',
    )!;
    const url = shield.craftVariants![0]!.craftOfExileUrl;
    expect(requirements(url)[0]!.e[0]!.i).toBe('1868');
    expect(new URL(url).searchParams.get('method')).toBe('3,2,20');
  });
  it('validates before writes, supports dry runs and preserves old revisions', async () => {
    const records: MarketTarget[] = [];
    const saveTarget = vi.fn(async (target: MarketTarget) => {
      const old = records.find((entry) => entry.digest === target.digest);
      if (old) return old;
      records.push(target);
      return target;
    });
    const repo = { listTargets: async () => records, saveTarget };
    const profile = {
      ...marketListingFixture().target,
      catalog: {
        key: 'belt',
        revision: 1,
        progression: null,
        verification: 'research' as const,
        unknowns: ['No live price'],
      },
    };
    const input = { schemaVersion: 1, profiles: [profile] };
    expect(await importMarketCatalog(input, repo, true)).toMatchObject({
      dryRun: true,
      created: 1,
    });
    expect(saveTarget).not.toHaveBeenCalled();
    await importMarketCatalog(input, repo);
    expect(await importMarketCatalog(input, repo)).toMatchObject({
      created: 0,
      unchanged: 1,
    });
    await expect(
      importMarketCatalog(
        {
          ...input,
          profiles: [
            profile,
            { ...profile, name: 'conflicting same revision' },
          ],
        },
        repo,
      ),
    ).rejects.toMatchObject({ code: 'MARKET_TARGET_INVALID' });
    expect(records).toHaveLength(1);
    await importMarketCatalog(
      {
        ...input,
        profiles: [
          {
            ...profile,
            name: 'revised',
            catalog: { ...profile.catalog, revision: 2 },
          },
        ],
      },
      repo,
    );
    expect(records).toHaveLength(2);
    expect(activeCatalogTargets(records)).toHaveLength(1);
    expect(activeCatalogTargets(records)[0]?.catalog?.revision).toBe(2);
    await importMarketCatalog(
      { ...input, profiles: [{ ...profile, league: 'New League' }] },
      repo,
    );
    expect(activeCatalogTargets(records)).toHaveLength(2);
  });
});
