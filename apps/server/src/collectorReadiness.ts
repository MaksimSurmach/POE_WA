import type {
  CollectorReadinessResponse,
  MarketReadiness,
  RecipeEvaluation,
} from '@poe-worksmith/contracts';
import {
  activityLookbackMs,
  exitMissSeparationMs,
} from '@poe-worksmith/domain';
import type { Pool } from 'pg';

import {
  captureLimit,
  eventLimit,
  listingLimit,
  sellerSightingsSql,
  summarizeCaptureActivity,
  type MarketActivityView,
} from './marketActivity.js';

const minute = 60_000;
const reportWindowMs = 24 * 60 * minute;

type ScheduleEvidence = {
  id: string;
  key: string;
  leagueId: string;
  league: string;
  name: string;
  role: CollectorReadinessResponse['targets'][number]['role'];
  intervalMinutes: number;
  outputRecipeIds: string[];
  captureId: string | null;
  capturedAt: Date | null;
  coverage: MarketReadiness['coverage'];
  currentListings: number;
  currentSellers: number;
  currentMin: number | null;
  currentMax: number | null;
  historyMin: number | null;
  historyMax: number | null;
  observations: Date[];
  complete: Date[];
  proofBaseline: Date | null;
  proofComplete: Date[];
  failed: number | null;
  failuresTrackedSince: Date | null;
  listings: number;
  sellers: number;
};

export type ReadinessEvidence = {
  schedule: ScheduleEvidence;
  activity: MarketActivityView | null;
};
export type CollectorReadinessReader = ReturnType<
  typeof createCollectorReadinessReader
>;

function askRange(min: number | null, max: number | null) {
  return min === null || max === null
    ? null
    : {
        min: { amount: min, currency: 'chaos' as const },
        max: { amount: max, currency: 'chaos' as const },
      };
}

export function targetReadiness(
  { schedule, activity }: ReadinessEvidence,
  now: Date,
  maximumQuoteAgeMs = 120 * minute,
  evaluation?: RecipeEvaluation,
): MarketReadiness {
  const captureAt = schedule.capturedAt?.getTime() ?? -Infinity;
  // A discovery query currently runs every six hours. Keep its latest sample
  // visible until the next planned pass plus one hour of scheduling tolerance.
  const maxAgeMs =
    schedule.role === 'discovery'
      ? (schedule.intervalMinutes + 60) * minute
      : maximumQuoteAgeMs;
  const fresh =
    captureAt <= now.getTime() && captureAt + maxAgeMs > now.getTime();
  const currentAskRange = askRange(schedule.currentMin, schedule.currentMax);
  const sourceMatches =
    schedule.captureId !== null &&
    schedule.captureId === evaluation?.source?.captureId;
  const comparableSellers = sourceMatches
    ? (evaluation?.source?.comparableSellers ?? null)
    : null;
  const comparableAsks =
    fresh &&
    schedule.coverage === 'complete' &&
    (schedule.role === 'output'
      ? Boolean(
          sourceMatches &&
          evaluation?.estimatedSalePrice &&
          evaluation.source?.comparable !== false &&
          (comparableSellers ?? 0) >= 2,
        )
      : Boolean(currentAskRange && schedule.currentSellers >= 2));
  const costVerified = Boolean(evaluation?.expectedCraftCost);
  const saleEligible = Boolean(sourceMatches && evaluation?.profit);
  const span = (times: Date[]) =>
    Math.floor(
      ((times.at(-1)?.getTime() ?? 0) - (times[0]?.getTime() ?? 0)) / minute,
    );
  const completeSpanMinutes = span(schedule.complete);
  const firstMiss = schedule.proofBaseline
    ? schedule.proofComplete
        .find((at) => at > schedule.proofBaseline!)
        ?.getTime()
    : undefined;
  const lastComplete = schedule.proofComplete.at(-1)?.getTime();
  const activityMeasurable =
    (activity?.inferredExits24h ?? 0) > 0 ||
    (firstMiss !== undefined &&
      lastComplete !== undefined &&
      lastComplete - firstMiss >= exitMissSeparationMs);
  const gaps = schedule.observations
    .slice(1)
    .map(
      (at, index) =>
        (at.getTime() - schedule.observations[index]!.getTime()) / minute,
    );
  const overdueIntervals =
    schedule.capturedAt === null
      ? null
      : gaps.reduce(
          (missing, gap) =>
            missing +
            Math.max(0, Math.floor(gap / schedule.intervalMinutes) - 1),
          0,
        ) +
        Math.floor(
          Math.min(reportWindowMs, now.getTime() - captureAt) /
            (schedule.intervalMinutes * minute),
        );
  const staleFloorCount = activity?.staleFloorCount ?? null;
  const inferredExits =
    activityMeasurable || activity?.inferredExits24h
      ? (activity?.inferredExits24h ?? null)
      : null;
  const exitSellers =
    inferredExits === null ? null : (activity?.inferredExitSellers24h ?? null);
  const candidate =
    comparableAsks &&
    saleEligible &&
    costVerified &&
    staleFloorCount === 0 &&
    schedule.complete.length >= 6 &&
    completeSpanMinutes >= 300 &&
    (inferredExits ?? 0) >= 3 &&
    (exitSellers ?? 0) >= 2;
  return {
    level: candidate
      ? 'preliminary-candidate'
      : activityMeasurable
        ? 'activity-measurable'
        : fresh && currentAskRange && schedule.currentSellers > 0
          ? 'price-observed'
          : 'insufficient',
    capturedAt: schedule.capturedAt?.toISOString() ?? null,
    fresh,
    coverage: schedule.coverage,
    currentListings: schedule.currentListings,
    currentSellers: schedule.currentSellers,
    comparableSellers,
    currentAskRange,
    staleFloorCount,
    comparableAsks,
    costVerified,
    saleEligible,
    activityMeasurable,
    last24h: {
      complete: schedule.complete.length,
      partial: schedule.observations.length - schedule.complete.length,
      failed: schedule.failed,
      failuresTrackedSince:
        schedule.failuresTrackedSince?.toISOString() ?? null,
      spanMinutes: span(schedule.observations),
      completeSpanMinutes,
      largestGapMinutes: gaps.length ? Math.floor(Math.max(...gaps)) : null,
      overdueIntervals,
      sellers: schedule.sellers,
      listings: schedule.listings,
      repriced: activity?.repriced24h ?? null,
      inferredExits,
      exitSellers,
      uncertainExits: activity?.uncertainExits24h ?? null,
      relisted: activity?.relisted24h ?? null,
      askRange: askRange(schedule.historyMin, schedule.historyMax),
    },
  };
}

type ActivityInput = Parameters<typeof summarizeCaptureActivity>[0];

function bySchedule<T extends { scheduleId: string }>(rows: T[]) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.scheduleId);
    if (group) group.push(row);
    else groups.set(row.scheduleId, [row]);
  }
  return groups;
}

export function createCollectorReadinessReader(pool: Pool) {
  async function read(
    now: Date,
    maximumQuoteAgeMs: number,
  ): Promise<ReadinessEvidence[]> {
    const client = await pool.connect();
    try {
      await client.query('begin isolation level repeatable read read only');
      const since = new Date(now.getTime() - reportWindowMs);
      const { rows } = await client.query<ScheduleEvidence>(
        `select s.id, s.key, s.league_id as "leagueId", l.ggg_id as league,
        coalesce(s.payload->>'name', names.name, 'Trade target') as name,
        case when s.payload->>'discovery' = 'true' then 'discovery'
             when jsonb_array_length(coalesce(s.payload->'outputRecipeIds', '[]')) > 0
               or (not (s.payload ? 'outputRecipeIds') and s.interval_minutes = 60)
               then 'output'
             else 'base' end as role,
        s.interval_minutes as "intervalMinutes",
        array(select jsonb_array_elements_text(coalesce(s.payload->'outputRecipeIds', '[]'))) as "outputRecipeIds",
        case when latest.captured_at <= $2 then latest.id end as "captureId",
        case when latest.captured_at <= $2 then latest.captured_at end as "capturedAt",
        case when latest.captured_at > $2 then null
             when latest.complete and latest.sorted_sample_ids is null then 'complete'
             when latest.id is not null then 'partial' end as coverage,
        sight."currentListings", sight."currentSellers", sight."currentMin", sight."currentMax",
        sight.listings, sight.sellers, history.*,
        case when telemetry.telemetry_started_at is not null then failure.failed end as failed,
        telemetry.telemetry_started_at as "failuresTrackedSince"
      from collector_schedule s
      join poe_leagues l on l.id = s.league_id and l.is_current
      left join collector_state telemetry on telemetry.id = 1
      left join lateral (
        select string_agg(distinct r.title, ', ' order by r.title) as name
        from recipes r where r.active and s.payload->'recipeIds' ? r.id
      ) names on true
      left join lateral (
        select id, captured_at, complete, sorted_sample_ids from captures
        where schedule_id = s.id and (query_version is null or query_version = s.key)
        order by captured_at desc limit 1
      ) latest on true
      left join lateral (
        select count(*) filter (where is_current)::int as "currentListings",
          count(distinct seller) filter (where is_current and price_chaos is not null)::int as "currentSellers",
          min(price_chaos) filter (where is_current)::float8 as "currentMin",
          max(price_chaos) filter (where is_current)::float8 as "currentMax",
          count(*) filter (where last_seen_at >= $1)::int as listings,
          count(distinct seller) filter (where last_seen_at >= $1)::int as sellers
        from (
          select *, last_capture_id = latest.id and status = 'active'
            and (latest.sorted_sample_ids is null or item_id = any(latest.sorted_sample_ids)) as is_current
          from listings where schedule_id = s.id and last_seen_at <= $2
            and (last_seen_at >= $1 or last_capture_id = latest.id)
        ) cohort
      ) sight on true
      left join lateral (
        select coalesce(array_agg(captured_at order by captured_at), '{}') as observations,
          coalesce(array_agg(captured_at order by captured_at) filter (where complete and sorted_sample_ids is null), '{}') as complete,
          min(captured_at) filter (where query_version = s.key and complete and sorted_sample_ids is null
            and floor_chaos is not null) as "proofBaseline",
          coalesce(array_agg(captured_at order by captured_at) filter (
            where complete and sorted_sample_ids is null and query_version = s.key), '{}') as "proofComplete",
          min(observed_min_chaos) filter (where query_version = s.key)::float8 as "historyMin",
          max(observed_max_chaos) filter (where query_version = s.key)::float8 as "historyMax"
        from captures where schedule_id = s.id and captured_at between $1 and $2
          and (query_version is null or query_version = s.key)
      ) history on true
      left join lateral (
        select count(*)::int as failed from collector_telemetry_runs
        where schedule_id = s.id and kind = 'trade-target' and outcome = 'failed'
          and finished_at between greatest($1, telemetry.telemetry_started_at) and $2
      ) failure on telemetry.telemetry_started_at is not null
      where s.enabled and s.kind = 'trade-target'
      order by name, s.key`,
        [since, now],
      );
      const scheduleIds = rows
        .filter(({ capturedAt }) => capturedAt !== null)
        .map(({ id }) => id);
      const historySince = new Date(now.getTime() - activityLookbackMs);
      const { rows: captures } = await client.query<
        ActivityInput['captureRows'][number] & { scheduleId: string }
      >(
        `select s.id as "scheduleId", c.id, c.captured_at as "capturedAt", c.complete,
          c.sorted_sample_ids as "sortedSampleIds", c.floor_chaos as "floorChaos",
          c.query_version as "queryVersion"
        from collector_schedule s cross join lateral (
          select * from captures where schedule_id = s.id and captured_at between $2 and $3
            and (query_version is null or query_version = s.key)
          order by captured_at desc limit $4
        ) c where s.id = any($1)
        order by s.id, c.captured_at desc`,
        [scheduleIds, historySince, now, captureLimit + 1],
      );
      const { rows: listings } = await client.query<
        ActivityInput['listingRows'][number] & { scheduleId: string }
      >(
        `select s.id as "scheduleId", l.item_id as "itemId", l.seller, l.fingerprint, l.price_chaos as "priceChaos",
          l.first_seen_at as "firstSeenAt", l.last_seen_at as "lastSeenAt", l.last_capture_id as "lastCaptureId",
          l.status, l.gone_at as "goneAt", l.unchanged_ask_since as "unchangedAskSince"
        from unnest($1::uuid[]) as s(id) cross join lateral (
          select * from listings where schedule_id = s.id and last_seen_at <= $3
            and (last_seen_at >= $2 or gone_at >= $2) limit $4
        ) l`,
        [scheduleIds, historySince, now, listingLimit + 1],
      );
      const { rows: events } = await client.query<
        ActivityInput['eventRows'][number] & { scheduleId: string }
      >(
        `select s.id as "scheduleId", e.item_id as "itemId", e.at, e.type,
          e.related_item_id as "relatedItemId"
        from unnest($1::uuid[]) as s(id) cross join lateral (
          select * from listing_events where schedule_id = s.id and at between $2 and $3
            and type in ('price_changed', 'missed', 'possible_relist') limit $4
        ) e`,
        [scheduleIds, historySince, now, eventLimit + 1],
      );
      const { rows: sightings } = await client.query<
        NonNullable<ActivityInput['sellerSightings']>[number] & {
          scheduleId: string;
        }
      >(sellerSightingsSql, [scheduleIds, historySince, now]);
      await client.query('commit');
      const captureGroups = bySchedule(captures);
      const listingGroups = bySchedule(listings);
      const eventGroups = bySchedule(events);
      const sightingGroups = bySchedule(sightings);
      return rows.map((schedule) => ({
        schedule,
        activity: summarizeCaptureActivity({
          captureRows: captureGroups.get(schedule.id) ?? [],
          listingRows: listingGroups.get(schedule.id) ?? [],
          eventRows: eventGroups.get(schedule.id) ?? [],
          sellerSightings: sightingGroups.get(schedule.id) ?? [],
          scheduleKey: schedule.key,
          now,
          maximumQuoteAgeMs:
            schedule.role === 'discovery'
              ? (schedule.intervalMinutes + 60) * minute
              : maximumQuoteAgeMs,
        }),
      }));
    } catch (cause) {
      await client.query('rollback');
      throw cause;
    } finally {
      client.release();
    }
  }
  // Concurrent clients share the same bounded database report. Single-target
  // resource reads use this same snapshot so catalog and report agree.
  let cached:
    | { at: number; ageMs: number; promise: Promise<ReadinessEvidence[]> }
    | undefined;
  return (now: Date, maximumQuoteAgeMs = 120 * minute) => {
    if (
      cached &&
      cached.ageMs === maximumQuoteAgeMs &&
      now.getTime() >= cached.at &&
      now.getTime() - cached.at < minute / 2
    )
      return cached.promise;
    const promise = read(now, maximumQuoteAgeMs)
      .then((rows) => {
        // A new database should report its first capture on the next read.
        if (
          cached?.promise === promise &&
          !rows.some(({ schedule }) => schedule.captureId)
        )
          cached = undefined;
        return rows;
      })
      .catch((cause: unknown) => {
        if (cached?.promise === promise) cached = undefined;
        throw cause;
      });
    cached = { at: now.getTime(), ageMs: maximumQuoteAgeMs, promise };
    return promise;
  };
}
