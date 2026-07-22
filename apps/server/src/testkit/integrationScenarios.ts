import type { MarketSearchResult } from '@poe-worksmith/domain';
import { FIXTURE_NOW } from './fixedClock.js';
import {
  expectedDefaultQueryHashes,
  expectedDefaultQueryKeys,
} from './integrationCatalog.js';
import type {
  DeterministicProviderScript,
  ProviderStep,
} from './deterministicMarketProvider.js';

export const integrationScenarioNames = [
  'all-success',
  'publish-at-95',
  'reject-below-95',
  'retry-429-then-success',
  'timeout-exhausted',
  'malformed-response',
  'stale-fallback',
  'cross-league-no-reuse',
] as const;
export type IntegrationScenarioName = (typeof integrationScenarioNames)[number];
const prices: Record<string, readonly number[]> = {
  'fixture:base:a': [10],
  'fixture:base:c': [20],
  'fixture:base:legacy': [5],
  'fixture:base:production': [10],
  'fixture:material:jagged': [2],
  'fixture:material:resonator': [1],
  'fixture:material:lifeforce': [0.02],
  'fixture:material:legacy': [3],
  'fixture:material:production:jagged': [2],
  'fixture:material:production:resonator': [1],
  'fixture:output:a': [100],
  'fixture:output:b': [120],
  'fixture:output:c': [150],
  'fixture:output:d': [180],
  'fixture:output:production': [100],
  'fixture:output:legacy': [70, 71, 72, 74, 76, 78, 80, 82, 84, 86, 88, 90, 92],
};
export async function integrationScenario(
  name: IntegrationScenarioName,
  league = 'Fixture League',
): Promise<DeterministicProviderScript> {
  const hashes = await expectedDefaultQueryHashes(league);
  const script: Record<string, readonly ProviderStep[]> = Object.fromEntries(
    hashes.map((hash, index) => [
      hash,
      [
        {
          type: 'success',
          result: result(
            (expectedDefaultQueryKeys as readonly string[])[index]!,
          ),
        },
      ],
    ]),
  );
  const set = (
    key: (typeof expectedDefaultQueryKeys)[number],
    steps: readonly ProviderStep[],
  ) => {
    script[hashes[expectedDefaultQueryKeys.indexOf(key)]!] = steps;
  };
  if (name === 'publish-at-95')
    set('fixture:output:legacy', [
      { type: 'success', result: result('fixture:output:legacy', 11) },
    ]);
  if (name === 'reject-below-95')
    set('fixture:output:legacy', [
      { type: 'success', result: result('fixture:output:legacy', 10) },
    ]);
  if (name === 'retry-429-then-success')
    set('fixture:material:lifeforce', [
      { type: 'error', errorCode: 'PROVIDER_RATE_LIMITED' },
      { type: 'success', result: result('fixture:material:lifeforce') },
    ]);
  if (name === 'timeout-exhausted')
    set(
      'fixture:output:d',
      Array.from({ length: 3 }, () => ({
        type: 'error' as const,
        errorCode: 'PROVIDER_UNAVAILABLE',
      })),
    );
  if (name === 'malformed-response')
    set('fixture:output:d', [{ type: 'malformed' }]);
  return script;
}
function result(
  key: string,
  count = key === 'fixture:output:legacy' ? 13 : 11,
): MarketSearchResult {
  const values = prices[key] ?? [1];
  const listings = Array.from({ length: count }, (_, index) => ({
    account: index === 1 ? 'fixture-seller-0' : `fixture-seller-${index}`,
    ageSeconds: 60 + index,
    fee: null,
    id: `fixture-${key.replaceAll(':', '-')}-${index}`,
    indexedAt: new Date(FIXTURE_NOW.getTime() - (60 + index) * 1000),
    item: { fixtureKey: key },
    price: {
      amount: String(
        index === 1 && values.length === 1
          ? values[0]! + 1
          : (values[index] ?? values[0]),
      ),
      currency: 'chaos',
    },
  }));
  return {
    fetchedAt: new Date(FIXTURE_NOW),
    listings,
    provider: 'poe-trade',
    totalResults: listings.length,
  };
}
