import { createDatabasePool } from '../database.js';
import { transitionRefreshCycle } from '@poe-worksmith/domain';
import { evaluateAndPublishCatalog } from '../catalogPublisher.js';
import { loadDatabaseConfig } from '../config.js';
import { MarketJobProcessor } from '../marketJobProcessor.js';
import { planCatalogRefresh } from '../refreshPlanner.js';
import { createPostgresRepositories } from '../repositories/index.js';
import { synchronizeRecipes } from '../recipes/synchronizeRecipes.js';
import {
  integrationScenarioNames,
  DeterministicMarketProvider,
  FixedClock,
  integrationMarketDependencies,
  integrationScenario,
  loadIntegrationCatalog,
  type IntegrationScenarioName,
} from '../testkit/index.js';

const args = process.argv.slice(2);
const scenario =
  args[0] === '--scenario' &&
  integrationScenarioNames.includes(args[1] as IntegrationScenarioName)
    ? (args[1] as IntegrationScenarioName)
    : undefined;
if (!scenario)
  throw new Error(
    `Usage: fixtures:seed-integration --scenario <${integrationScenarioNames.join('|')}>`,
  );
if (process.env.APP_ENV !== 'test' && process.env.APP_ENV !== 'development')
  throw new Error(
    'fixtures:seed-integration requires APP_ENV=test or APP_ENV=development',
  );
const pool = createDatabasePool(loadDatabaseConfig());
try {
  const repositories = createPostgresRepositories(pool);
  const recipes = await loadIntegrationCatalog();
  const report = await synchronizeRecipes(
    repositories.recipes,
    recipes,
    async () => new Uint8Array(),
  );
  if (report.failed.length) throw new Error('Fixture synchronization failed');
  const league = await repositories.leagues.upsert({
    endAt: null,
    game: 'poe1',
    gggId: 'Fixture League',
    isCurrent: true,
    metadata: {},
    name: 'Fixture League',
    realm: 'pc',
    startAt: null,
    syncedAt: new Date('2026-07-20T12:00:00.000Z'),
  });
  const clock = new FixedClock();
  const provider = new DeterministicMarketProvider(
    await integrationScenario(scenario, league.gggId),
  );
  const plan = await planCatalogRefresh(repositories, {
    league: {
      leagueGggId: league.gggId,
      leagueId: league.id,
      leagueName: league.name,
    },
    marketDependencies: integrationMarketDependencies,
    now: clock.now(),
    snapshotTtlMs: 5 * 60 * 1000,
  });
  const processor = new MarketJobProcessor({
    clock: clock.now,
    concurrency: 1,
    leaseTimeoutMs: 10_000,
    providers: [provider],
    repositories,
    retryDelayMs: 1_000,
    snapshotTtlMs: 5 * 60 * 1000,
  });
  await repositories.cycles.save(
    transitionRefreshCycle(plan.cycle, 'running', clock.now()),
  );
  for (let attempt = 0; attempt < 32; attempt += 1) {
    await processor.runAvailable('fixture-seed', clock.now());
    clock.advanceMilliseconds(1_000);
  }
  const publication = await evaluateAndPublishCatalog(repositories, {
    cycleId: plan.cycle.id,
    league: league.gggId,
    leagueName: league.name,
    marketDependencies: integrationMarketDependencies,
    now: clock.now(),
  });
  const evaluations = publication.evaluations;
  process.stdout.write(
    JSON.stringify({
      cycleId: plan.cycle.id,
      leagueId: league.id,
      providerCalls: provider.totalCalls(),
      published: publication.published,
      recipes: recipes.length,
      scenario,
      stale: evaluations.filter(({ status }) => status === 'stale').length,
      synced:
        report.created.length + report.updated.length + report.unchanged.length,
      uniqueQueries: plan.report.totalQueries,
      succeeded: evaluations.filter(({ status }) => status === 'success')
        .length,
      failed: evaluations.filter(({ status }) => status === 'error').length,
    }) + '\n',
  );
} finally {
  await pool.end();
}
