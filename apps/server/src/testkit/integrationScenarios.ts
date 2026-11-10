import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import {
  clusterJewelVariantFilter,
  mappedTargetFilter,
  RegisteredTradeQueryGenerator,
  type MarketSearchResult,
} from '@poe-worksmith/domain';
import { evaluateAndPublishCatalog } from '../catalogPublisher.js';
import { runCollector } from '../collector.js';
import { createCollectorResultPublisher } from '../collectorResults.js';
import { loadCollectorScheduleConfig } from '../runtimeConfig.js';
import {
  newEconomyAttempt,
  newStoredEconomySnapshot,
} from '../marketEconomy.js';
import {
  createRecipeMarketDependencies,
  recipeQueryTarget,
} from '../recipeMarket.js';
import { loadRecipeCatalog } from '../recipes/loader.js';
import {
  synchronizeCollectorSchedules,
  synchronizeRecipes,
} from '../recipes/synchronizeRecipes.js';
import { planCatalogRefresh } from '../refreshPlanner.js';
import { createMarketEconomyRepository } from '../repositories/marketEconomyRepository.js';
import { createPostgresRepositories } from '../repositories/postgresRepositories.js';
import {
  createPostgresResourceResolver,
  createPostgresTradeMappingCatalog,
  importTradeMappings,
} from '../tradeMappings.js';
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
  'fixture:material:production:alteration': [0.08],
  'fixture:material:production:transmutation': [0.03],
  'fixture:output:a': [100],
  'fixture:output:b': [120],
  'fixture:output:c': [150],
  'fixture:output:d': [180],
  'fixture:output:production:alteration': [100],
  'fixture:output:production:jagged': [100],
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
  if (name === 'publish-at-95' || name === 'reject-below-95')
    set('fixture:output:boundary-one', [{ type: 'malformed' }]);
  if (name === 'reject-below-95')
    set('fixture:output:boundary-two', [{ type: 'malformed' }]);
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

export const twoMethodsPricedScenario = 'two-methods-priced';

export function assertLocalBrowserFixtureDatabase() {
  const target = new URL(
    process.env.TEST_DATABASE_URL ?? 'postgresql://invalid',
  );
  if (
    process.env.APP_ENV !== 'test' ||
    !['127.0.0.1', 'localhost'].includes(target.hostname) ||
    target.pathname !== '/poe_worksmith_test' ||
    !target.port ||
    target.port === '54326' ||
    target.search
  )
    throw new Error(
      'Browser tests require the isolated local poe_worksmith_test database; native data is never reset.',
    );
}

async function prepareTwoMethodsPriced(pool: Pool) {
  const repositories = createPostgresRepositories(pool);
  const root = fileURLToPath(new URL('../../../../recipes/', import.meta.url));
  const recipes = (await loadRecipeCatalog(root)).filter(({ definition }) =>
    ['physical-large-cluster-jagged', 'physical-large-cluster-chaos'].includes(
      definition.id,
    ),
  );
  assert.equal(recipes.length, 2);
  const report = await synchronizeRecipes(
    repositories.recipes,
    recipes,
    (path) => readFile(resolve(root, path)),
  );
  assert.deepEqual(report.failed, []);

  const patch = '3.29.3.3';
  await pool.query(
    `update game_data_versions set status = 'archived'
     where game = 'poe1' and status = 'active' and patch_version <> $1`,
    [patch],
  );
  await pool.query(
    `insert into game_data_versions (game, patch_version, source, source_revision, manifest_hash, status)
     values ('poe1', $1, 'browser-fixture', 'browser-fixture', 'two-methods-priced', 'active')
     on conflict (game) where status = 'active' do nothing`,
    [patch],
  );
  for (const name of ['physical-large-cluster', 'recipe-catalog']) {
    const manifest = JSON.parse(
      await readFile(
        new URL(
          `../../mappings/poe-trade/${patch}/${name}.json`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await importTradeMappings(pool, {
      ...manifest,
      sourceRevision: manifest.mappingVersion,
    });
  }
  const marketDependencies = createRecipeMarketDependencies({
    resolveResource: createPostgresResourceResolver(pool),
    trade: new RegisteredTradeQueryGenerator(
      createPostgresTradeMappingCatalog(pool),
      [clusterJewelVariantFilter],
      [mappedTargetFilter],
    ),
  });

  const now = new Date();
  const timestamp = now.toISOString();
  const league = 'Standard';
  const { id: leagueId } = await repositories.leagues.upsert({
    endAt: null,
    game: 'poe1',
    gggId: league,
    isCurrent: true,
    metadata: {},
    name: league,
    realm: 'pc',
    startAt: null,
    syncedAt: now,
  });
  const economy = createMarketEconomyRepository(pool);
  const exchange = await economy.save(
    newStoredEconomySnapshot({
      schemaVersion: 1,
      kind: 'economy-overview',
      source: 'poe.ninja',
      game: 'poe1',
      league,
      category: 'Currency',
      endpoint: 'https://poe.ninja/fixture/two-methods-priced',
      payloadHash: '0'.repeat(64),
      capturedAt: timestamp,
      sourceUpdatedAt: null,
      priceBasis: 'currency-exchange',
      raw: { fixture: twoMethodsPricedScenario },
      lines: [
        {
          id: 'divine',
          name: 'Divine Orb',
          detailsId: 'divine-orb',
          baseType: null,
          price: { amount: 200, currency: 'chaos' },
          listingCount: null,
          observationCount: 10,
          tradedVolume: null,
        },
      ],
    }),
  );
  await economy.saveAttempt({
    ...newEconomyAttempt({ league, category: 'Currency', startedAt: now }),
    completedAt: timestamp,
    status: 'succeeded',
    cacheStatus: 'fetched',
    snapshotId: exchange.id,
  });

  return {
    repositories,
    marketDependencies,
    league,
    leagueId,
    economy,
    exchange,
    now,
  };
}

function pricedListings(
  query: object,
  key: string,
  at: Date,
  basePriceMultiplier = 1,
) {
  const patch = '3.29.3.3';
  const league = 'Standard';
  const clusterMods = [
    { id: 'enchant.stat_3086156145', value: 8 },
    { id: 'enchant.stat_3948993189|12', value: 12 },
    { id: 'enchant.stat_4079888060', value: 2 },
  ];
  const finishedMods = [
    ...clusterMods,
    { id: 'explicit.stat_4188581520', value: 1 },
    { id: 'explicit.stat_3415827027', value: 1 },
    { id: 'explicit.stat_3585232432', value: 1 },
  ];

  const target =
    'handbookTarget' in query && query.handbookTarget
      ? recipeQueryTarget(query.handbookTarget)
      : null;
  const finished = target?.slot === 'crafted-item';
  const rarity = target?.tradeSearch?.rarity ?? 'normal';
  const currency = finished ? ('divine' as const) : ('chaos' as const);
  const baseAsk = String((rarity === 'rare' ? 17 : 10) * basePriceMultiplier);
  const materialAsk =
    'exchange' in query &&
    JSON.stringify(query.exchange)?.includes('jagged-fossil')
      ? '2'
      : '3';
  const amount = finished ? '75' : target ? baseAsk : materialAsk;
  return Array.from({ length: finished ? 5 : 1 }, (_, index) => {
    const account = `seller-${index}`;
    return {
      id: `${key}-${index}`,
      account,
      ageSeconds: 60,
      fee: null,
      indexedAt: at.toISOString(),
      price: { amount, currency },
      item: target
        ? {
            baseType: 'Large Cluster Jewel',
            rarity,
            itemLevel: 83,
            league,
            patch,
            currency,
            seller: account,
            status: 'listed',
            corrupted: false,
            fractured: false,
            synthesised: false,
            influences: [],
            modsComplete: true,
            mods: finished ? finishedMods : clusterMods,
          }
        : { stock: 1000 },
    };
  });
}

export async function seedTwoMethodsPriced(pool: Pool) {
  const { repositories, marketDependencies, league, leagueId, economy, now } =
    await prepareTwoMethodsPriced(pool);
  const snapshotTtlMs = 30 * 60_000;
  const plan = await planCatalogRefresh(repositories, {
    league: { leagueId, leagueGggId: league, leagueName: league },
    marketDependencies,
    now,
    snapshotTtlMs,
  });
  assert.equal(plan.queries.length, 5);
  assert.equal(plan.report.deduplicatedDependencies, 1);

  for (const { marketQuery } of plan.queries) {
    const listings = pricedListings(
      marketQuery.query,
      String(marketQuery.id),
      now,
    );
    await repositories.snapshots.save({
      capturedAt: now,
      dedupeKey: `scheduled-trade:${plan.cycle.id}:${marketQuery.id}`,
      expiresAt: new Date(now.getTime() + snapshotTtlMs),
      leagueId,
      marketQueryId: marketQuery.id,
      payload: {
        listings,
        coverage: 'complete',
        totalResults: listings.length,
      },
      providerStatus: 200,
      refreshCycleId: plan.cycle.id,
    });
  }
  await repositories.cycles.save({
    ...plan.cycle,
    completedQueries: plan.queries.length,
  });
  const publication = await evaluateAndPublishCatalog(repositories, {
    cycleId: plan.cycle.id,
    league,
    marketDependencies,
    economy,
    now,
  });
  assert.equal(publication.published, true);
  assert.equal(publication.completedRecipes, 2);
  assert.equal(publication.failedRecipes, 0);
  return {
    scenario: twoMethodsPricedScenario,
    published: publication.published,
    succeeded: publication.completedRecipes,
    failed: publication.failedRecipes,
  };
}

/** Local browser fixture: provider data is synthetic; scheduling, writes and evaluation are real. */
export async function prepareCollectorBrowserFixture(pool: Pool) {
  const { exchange, now } = await prepareTwoMethodsPriced(pool);
  const schedules = await synchronizeCollectorSchedules(
    pool,
    loadCollectorScheduleConfig(),
    now,
  );
  assert.equal(schedules, 'synchronized');
  await pool.query(
    "update collector_schedule set enabled = false where kind <> 'trade-target'",
  );
  await pool.query('truncate collector_state');
  const success = async () => ({ status: 'success' as const });
  return (signal: AbortSignal) =>
    runCollector({
      pool,
      signal,
      publishResults: createCollectorResultPublisher(pool, async () => ({
        maximumQuoteAgeMs: 30 * 60_000,
        freshnessWarningMs: 15 * 60_000,
      })),
      handlers: {
        'trade-target': async (schedule) => {
          const query = schedule.payload.query;
          assert(query && typeof query === 'object' && !Array.isArray(query));
          const capturedAt = new Date();
          const listings = pricedListings(
            query,
            schedule.key,
            capturedAt,
            schedule.lastFinishedAt ? 2 : 1,
          ).map(({ id, account, item, price }) => ({
            itemId: id,
            seller: account,
            indexedAt: capturedAt,
            fingerprint: null,
            item,
            price,
            priceChaos:
              price.currency === 'divine'
                ? String(Number(price.amount) * 200)
                : price.amount,
          }));
          return {
            status: 'success',
            capture: {
              capturedAt,
              reportedTotal: listings.length,
              fetched: listings.length,
              complete: true,
              durationMs: 0,
              fxSnapshotId: exchange.id,
              slices: 1,
              listings,
            },
          };
        },
        economy: success,
        league: success,
        retention: success,
      },
    });
}
