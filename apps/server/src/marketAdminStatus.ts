import { CronExpressionParser } from 'cron-parser';
import type {
  MarketAdminStatus,
  CatalogResponse,
} from '@poe-worksmith/contracts';
import type { Repositories } from '@poe-worksmith/domain';
import type { MarketCollectionManager } from './marketCollection.js';
import type { MarketEconomyRepository } from './marketEconomy.js';
import type { NinjaEconomyClient } from './providers/ninjaEconomy.js';
import type { MarketAdminStore } from './marketAdmin.js';

export function createMarketAdminStatusReader(options: {
  store: MarketAdminStore;
  repositories: Repositories;
  collection: MarketCollectionManager;
  economy: MarketEconomyRepository;
  ninja: NinjaEconomyClient;
  readCatalog(id: string): Promise<CatalogResponse>;
}) {
  return async (): Promise<MarketAdminStatus> => {
    const [settings, health, league, runs, rateLimits, catalog, attempts] =
      await Promise.all([
        options.store.read(),
        options.store.workerHealth(),
        options.repositories.leagues.findCurrent(),
        options.store.runs(),
        options.repositories.rateLimits.list(),
        options.readCatalog('admin-status'),
        options.economy.listAttempts(),
      ]);
    const { effective } = settings;
    const enabled =
      effective.automaticRefreshEnabled &&
      effective.scheduledCollectionEnabled &&
      !effective.collectionsPaused;
    const source = options.collection.source;
    const entries = catalog.data?.entries ?? [];
    const now = Date.now();
    const latestSnapshotAt =
      entries
        .map((e) => e.snapshot?.capturedAt)
        .filter((v): v is string => Boolean(v))
        .sort()
        .at(-1) ?? null;
    return {
      serverTime: new Date(now).toISOString(),
      access: 'local-only',
      league: league
        ? {
            name: league.name,
            confirmed:
              league.metadata.tradeObserved === true &&
              league.metadata.poeNinjaObserved === true,
          }
        : null,
      trade: {
        configured: source.access === 'authorized',
        status: source.connectionStatus ?? source.access,
        reason: source.reason ?? null,
      },
      ninja: {
        configured: true,
        status: options.ninja.cooldownUntil
          ? 'COOLDOWN'
          : (attempts[0]?.status ?? 'not-checked'),
        cooldownUntil: options.ninja.cooldownUntil,
      },
      worker: health,
      scheduler: {
        healthy: health.healthy && health.settingsVersion === settings.version,
        enabled,
        cron: effective.refreshCron,
        nextRefreshAt: enabled
          ? CronExpressionParser.parse(effective.refreshCron, {
              tz: settings.timezone,
            })
              .next()
              .toISOString()
          : null,
      },
      activeRun:
        runs.find((r) => ['queued', 'running'].includes(r.status)) ?? null,
      lastSuccessful: runs.find((r) => r.status === 'succeeded') ?? null,
      lastFailed: runs.find((r) => r.status === 'failed') ?? null,
      collection: {
        paused: effective.collectionsPaused,
        scheduled: enabled,
        manualAvailable:
          effective.manualRefreshEnabled &&
          !effective.collectionsPaused &&
          health.healthy,
      },
      coverage: {
        activeRecipes: entries.length,
        pricedRecipes: entries.filter(
          (e) => e.evaluation.estimatedSalePrice !== null,
        ).length,
        freshRecipes: entries.filter(
          (e) =>
            e.evaluation.estimatedSalePrice !== null &&
            e.snapshot?.capturedAt &&
            now - Date.parse(e.snapshot.capturedAt) <=
              effective.maximumQuoteAgeMs,
        ).length,
        warningRecipes: entries.filter(
          (e) =>
            e.snapshot?.capturedAt &&
            now - Date.parse(e.snapshot.capturedAt) >
              effective.freshnessWarningMs,
        ).length,
        latestSnapshotAt,
      },
      rateLimits: rateLimits.map((r) => ({
        policy: r.policy,
        lastStatus: r.lastStatus,
        waitingUntil: new Date(
          Math.max(r.blockedUntil.getTime(), r.nextRequestAt.getTime()),
        ).toISOString(),
        minimumDelayMs: r.minimumDelayMs,
      })),
      warnings: [
        ...settings.warnings,
        ...(!health.healthy
          ? [
              'No live worker heartbeat. Queued refreshes need a running worker.',
            ]
          : []),
      ],
    };
  };
}
