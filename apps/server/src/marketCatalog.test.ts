import { describe, expect, it, vi } from 'vitest';
import { beltDemoFixture } from './beltDemoFixture.js';
import { activeCatalogTargets, importMarketCatalog } from './marketCatalog.js';
import type { MarketTarget } from '@poe-worksmith/contracts';

describe('versioned JSON catalog', () => {
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
      ...beltDemoFixture().target,
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
