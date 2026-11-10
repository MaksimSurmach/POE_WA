import { marketTargetInputSchema } from '@poe-worksmith/contracts';
import { hashMarketQuery } from '@poe-worksmith/domain';
import type { Pool } from 'pg';

import {
  createCollectorReadinessReader,
  targetReadiness,
} from './collectorReadiness.js';
import { canonicalMarketJson } from './marketResearch.js';
import { marketStarterLibrary } from './marketStarterLibrary.js';
import type { collectorSchedule } from './schema.js';

const intervalMinutes = 6 * 60;
const cohorts = [
  [70, 10],
  [100, 14],
] as const;

export async function discoverySchedules(
  league: { id: string; gggId: string },
  now: Date,
): Promise<(typeof collectorSchedule.$inferInsert)[]> {
  const profile = marketStarterLibrary.find(({ slot }) => slot === 'Колчан');
  if (!profile || profile.league !== league.gggId) return [];
  return Promise.all(
    cohorts.map(async ([life, speed], index) => {
      const name = `Broadhead Arrow Quiver · ${life}+ life · ${speed}%+ attack speed`;
      const target = marketTargetInputSchema.parse({
        ...profile,
        name,
        patch: '3.29.3.3',
        minItemLevel: 76,
        corrupted: false,
        synthesised: false,
        requiredMods: [`${life}+ life`, `${speed}%+ attack speed`],
        tradeSearch: {
          version: 1,
          scope: 'strict',
          status: 'available',
          currency: 'chaos',
          rarity: 'rare',
          groups: [
            {
              type: 'and',
              filters: [
                { id: 'explicit.stat_3299347043', min: life },
                { id: 'explicit.stat_681332047', min: speed },
              ],
            },
          ],
        },
      });
      const query = {
        provider: 'poe-trade' as const,
        schemaVersion: 1 as const,
        query: { handbookTarget: canonicalMarketJson(target) },
      };
      return {
        kind: 'trade-target',
        key: await hashMarketQuery({ ...query, league: league.gggId }),
        leagueId: league.id,
        payload: { ...query, discovery: true, name },
        intervalMinutes,
        nextDueAt: new Date(now.getTime() + (15 + index) * 60_000),
      };
    }),
  );
}

export async function readMarketDiscovery(pool: Pool, now = new Date()) {
  const evidence = await createCollectorReadinessReader(pool)(now);
  return {
    evaluatedAt: now.toISOString(),
    priceBasis: 'observed asks',
    sales: 'unknown',
    entries: evidence
      .filter(({ schedule }) => schedule.role === 'discovery')
      .map((target) => ({
        name: target.schedule.name,
        intervalMinutes: target.schedule.intervalMinutes,
        readiness: targetReadiness(target, now),
      })),
  };
}
