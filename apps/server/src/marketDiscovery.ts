import { marketTargetInputSchema } from '@poe-worksmith/contracts';
import { hashMarketQuery } from '@poe-worksmith/domain';
import type { Pool } from 'pg';

import { createMarketActivityReader } from './marketActivity.js';
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
  const { rows } = await pool.query<{
    key: string;
    leagueId: string;
    name: string;
  }>(
    `select s.key, s.league_id as "leagueId", s.payload->>'name' as name
     from collector_schedule s join poe_leagues l on l.id=s.league_id and l.is_current
     where s.enabled and s.kind='trade-target' and s.payload->>'discovery'='true'
     order by s.key limit 20`,
  );
  const readActivity = createMarketActivityReader(pool);
  const entries = [];
  for (const { key, leagueId, name } of rows) {
    const activity = await readActivity(
      leagueId,
      key,
      now,
      (intervalMinutes + 60) * 60_000,
    );
    entries.push({
      name,
      captureAt: activity?.capturedAt ?? null,
      fullCoverage: activity?.active !== undefined && activity.active !== null,
      inferredExits72h: activity?.inferredExits72h ?? null,
      uncertainExits72h: activity?.uncertainExits72h ?? null,
      lowestObservedAskChaos: activity?.observedAskSample?.[0]?.amount ?? null,
    });
  }
  const ranked = entries
    .filter(
      (entry) => entry.fullCoverage && entry.lowestObservedAskChaos !== null,
    )
    .sort(
      (left, right) =>
        (right.inferredExits72h ?? 0) - (left.inferredExits72h ?? 0) ||
        (right.lowestObservedAskChaos ?? 0) -
          (left.lowestObservedAskChaos ?? 0),
    );
  return {
    evaluatedAt: now.toISOString(),
    priceBasis: 'observed asks',
    sales: 'unknown',
    ranked,
    insufficientCoverage: entries.filter((entry) => !ranked.includes(entry)),
  };
}
