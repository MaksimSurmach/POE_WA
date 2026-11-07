import { CronExpressionParser } from 'cron-parser';
import type { CatalogProgress, RefreshCycle } from '@poe-worksmith/domain';

export type RefreshFreshnessState =
  | 'never-published'
  | 'scheduled'
  | 'queued'
  | 'running'
  | 'failed'
  | 'published';

export type RefreshFreshness = {
  serverTime: Date;
  state: RefreshFreshnessState;
  schedule: { cron: string; timezone: string; nextScheduledAt: Date | null };
  active: RefreshCycle | null;
  published: RefreshCycle | null;
  lastAttempt: RefreshCycle | null;
  lastSuccessful: { cycleId: string; publishedAt: Date } | null;
};

export function deriveRefreshFreshness(input: {
  now: Date;
  enabled?: boolean;
  active: RefreshCycle | null;
  published: RefreshCycle | null;
  lastAttempt: RefreshCycle | null;
  cron: string;
  timezone: string;
}): RefreshFreshness {
  const nextScheduledAt =
    input.enabled === false
      ? null
      : CronExpressionParser.parse(input.cron, {
          currentDate: input.now,
          tz: input.timezone,
        })
          .next()
          .toDate();
  const state =
    input.active?.status === 'running'
      ? 'running'
      : input.active?.status === 'queued'
        ? 'queued'
        : input.lastAttempt?.status === 'failed' &&
            (!input.published ||
              input.lastAttempt.requestedAt > input.published.requestedAt)
          ? 'failed'
          : input.published
            ? 'published'
            : input.lastAttempt
              ? 'scheduled'
              : 'never-published';
  return {
    active: input.active,
    lastAttempt: input.lastAttempt,
    lastSuccessful: input.published?.publishedAt
      ? {
          cycleId: input.published.id,
          publishedAt: input.published.publishedAt,
        }
      : null,
    published: input.published,
    schedule: { cron: input.cron, timezone: input.timezone, nextScheduledAt },
    serverTime: input.now,
    state,
  };
}

export function createRefreshFreshnessReader(options: {
  getProgress: () => Promise<CatalogProgress>;
  findLatestAttempt: () => Promise<RefreshCycle | null>;
  readSchedule: () => Promise<{
    cron: string;
    timezone: string;
    enabled: boolean;
  }>;
  clock?: () => Date;
}) {
  return async () => {
    const now = (options.clock ?? (() => new Date()))();
    const [progress, lastAttempt, schedule] = await Promise.all([
      options.getProgress(),
      options.findLatestAttempt(),
      options.readSchedule(),
    ]);
    return deriveRefreshFreshness({
      ...progress,
      lastAttempt,
      now,
      ...schedule,
    });
  };
}
