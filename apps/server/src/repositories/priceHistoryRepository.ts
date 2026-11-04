import type { Pool, PoolClient } from 'pg';
import type { TrendRange } from '@poe-worksmith/contracts';

/**
 * Compact recipe price history.
 *
 * - `recipe_price_observations` keeps one row per independent output source
 *   snapshot for `observationDays`, then rows are rolled into daily UTC OHLC
 *   summaries in `recipe_price_daily` and deleted in the same statement.
 * - Daily summaries are kept for `dailyDays` (bounded by the operator's
 *   history retention setting).
 *
 * Saves never accept observations older than `observationDays`: once a source
 * snapshot is old enough to be rolled up, its raw dedupe row is gone, so a
 * carried-forward evaluation must not be able to count it twice.
 */
export const priceHistoryRetention = {
  observationDays: 30,
  dailyDays: 730,
  /** Accepted forward clock skew between the app and database clocks. */
  futureSkewMinutes: 5,
} as const;

export type PriceHistoryRange = TrendRange;

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;

/** Fixed UTC bucket origin; date_bin needs an explicit origin. */
export const priceHistoryBucketOrigin = '2000-01-01T00:00:00.000Z';

export const priceHistoryRanges: Record<
  PriceHistoryRange,
  { rangeMs: number; bucketMs: number; bucketInterval: string }
> = {
  '24h': { rangeMs: dayMs, bucketMs: hourMs, bucketInterval: '1 hour' },
  '7d': { rangeMs: 7 * dayMs, bucketMs: 4 * hourMs, bucketInterval: '4 hours' },
  '30d': { rangeMs: 30 * dayMs, bucketMs: dayMs, bucketInterval: '1 day' },
  '1y': { rangeMs: 365 * dayMs, bucketMs: dayMs, bucketInterval: '1 day' },
};

const origin = Date.parse(priceHistoryBucketOrigin);

/** Bucket-aligned window so daily summaries are never split by the window edge. */
export function priceHistoryWindow(range: PriceHistoryRange, now: Date) {
  const { rangeMs, bucketMs } = priceHistoryRanges[range];
  const start = now.getTime() - rangeMs;
  const aligned = origin + Math.floor((start - origin) / bucketMs) * bucketMs;
  return { start: new Date(aligned), end: now };
}

const observationColumns = `recipe_id, recipe_content_hash, league_id, currency,
  source_snapshot_dedupe_key, observed_at, ask, craft_cost, comparable_sellers,
  coverage, sorted_sample_complete, evaluation_id`;

/**
 * The single insert used by both the save path and migration 0024's backfill.
 * The earliest evaluation of a source snapshot wins; later carried or repeated
 * evaluations of the same snapshot conflict and are ignored.
 */
export function priceObservationInsertSql(options: {
  evaluationFilter: string | null;
  horizon: string;
}) {
  return `INSERT INTO recipe_price_observations (${observationColumns})
SELECT DISTINCT ON (c.recipe_id, c.recipe_content_hash, c.league_id, c.currency, c.source_snapshot_dedupe_key)
  c.recipe_id, c.recipe_content_hash, c.league_id, c.currency,
  c.source_snapshot_dedupe_key, c.observed_at, c.ask, c.craft_cost,
  c.comparable_sellers, c.coverage, c.sorted_sample_complete, c.evaluation_id
FROM recipe_price_observation_candidates c
WHERE ${options.evaluationFilter ? `${options.evaluationFilter}\n  AND ` : ''}c.observed_at IS NOT NULL
  AND c.observed_at <= c.evaluated_at
  AND c.observed_at <= now() + interval '${priceHistoryRetention.futureSkewMinutes} minutes'
  AND c.observed_at >= now() - ${options.horizon}
ORDER BY c.recipe_id, c.recipe_content_hash, c.league_id, c.currency, c.source_snapshot_dedupe_key, c.evaluated_at, c.evaluation_id
ON CONFLICT (recipe_id, recipe_content_hash, league_id, currency, source_snapshot_dedupe_key) DO NOTHING`;
}

/** Exact statement appended to migration 0024 (asserted by tests). */
export const priceObservationBackfillSql = priceObservationInsertSql({
  evaluationFilter: null,
  horizon: `interval '${priceHistoryRetention.dailyDays} days'`,
});

const recordEvaluationSql = priceObservationInsertSql({
  evaluationFilter: 'c.evaluation_id = $1',
  horizon: 'make_interval(days => $2::int)',
});

/** Records the saved evaluation's output observation inside the caller's transaction. */
export async function recordPriceObservation(
  client: Pick<PoolClient, 'query'>,
  evaluationId: number,
) {
  const result = await client.query(recordEvaluationSql, [
    evaluationId,
    priceHistoryRetention.observationDays,
  ]);
  return result.rowCount ?? 0;
}

const bucketOriginSql = `timestamptz '2000-01-01 00:00:00+00'`;

/** One statement: delete a batch of old observations and merge them into daily rows. */
const rollupSql = `WITH moved AS (
  DELETE FROM recipe_price_observations
  WHERE id IN (
    SELECT id FROM recipe_price_observations
    WHERE observed_at < least($1::timestamptz, now() - make_interval(days => $2::int))
    ORDER BY observed_at, id
    LIMIT $3
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *
), grouped AS (
  SELECT recipe_id, recipe_content_hash, league_id, currency,
    date_bin('1 day', observed_at, ${bucketOriginSql}) AS bucket_start,
    min(observed_at) AS first_observed_at,
    max(observed_at) AS last_observed_at,
    (array_agg(ask ORDER BY observed_at, id))[1] AS open_ask,
    max(ask) AS high_ask,
    min(ask) AS low_ask,
    (array_agg(ask ORDER BY observed_at DESC, id DESC))[1] AS close_ask,
    count(*)::int AS observation_count,
    (array_agg(craft_cost ORDER BY observed_at DESC, id DESC) FILTER (WHERE craft_cost IS NOT NULL))[1] AS craft_cost,
    max(observed_at) FILTER (WHERE craft_cost IS NOT NULL) AS craft_cost_observed_at,
    min(comparable_sellers) AS min_comparable_sellers,
    (array_agg(comparable_sellers ORDER BY observed_at DESC, id DESC))[1] AS last_comparable_sellers
  FROM moved
  GROUP BY recipe_id, recipe_content_hash, league_id, currency, 5
), merged AS (
  INSERT INTO recipe_price_daily AS d (
    recipe_id, recipe_content_hash, league_id, currency, bucket_start,
    first_observed_at, last_observed_at, open_ask, high_ask, low_ask, close_ask,
    observation_count, craft_cost, craft_cost_observed_at,
    min_comparable_sellers, last_comparable_sellers
  )
  SELECT recipe_id, recipe_content_hash, league_id, currency, bucket_start,
    first_observed_at, last_observed_at, open_ask, high_ask, low_ask, close_ask,
    observation_count, craft_cost, craft_cost_observed_at,
    min_comparable_sellers, last_comparable_sellers
  FROM grouped
  ON CONFLICT (recipe_id, recipe_content_hash, league_id, currency, bucket_start) DO UPDATE SET
    open_ask = CASE WHEN excluded.first_observed_at < d.first_observed_at THEN excluded.open_ask ELSE d.open_ask END,
    first_observed_at = least(d.first_observed_at, excluded.first_observed_at),
    close_ask = CASE WHEN excluded.last_observed_at > d.last_observed_at THEN excluded.close_ask ELSE d.close_ask END,
    last_comparable_sellers = CASE WHEN excluded.last_observed_at > d.last_observed_at THEN excluded.last_comparable_sellers ELSE d.last_comparable_sellers END,
    last_observed_at = greatest(d.last_observed_at, excluded.last_observed_at),
    high_ask = greatest(d.high_ask, excluded.high_ask),
    low_ask = least(d.low_ask, excluded.low_ask),
    observation_count = d.observation_count + excluded.observation_count,
    craft_cost = CASE WHEN excluded.craft_cost_observed_at IS NOT NULL AND (d.craft_cost_observed_at IS NULL OR excluded.craft_cost_observed_at > d.craft_cost_observed_at) THEN excluded.craft_cost ELSE d.craft_cost END,
    craft_cost_observed_at = CASE WHEN excluded.craft_cost_observed_at IS NOT NULL AND (d.craft_cost_observed_at IS NULL OR excluded.craft_cost_observed_at > d.craft_cost_observed_at) THEN excluded.craft_cost_observed_at ELSE d.craft_cost_observed_at END,
    min_comparable_sellers = least(d.min_comparable_sellers, excluded.min_comparable_sellers),
    updated_at = now()
  RETURNING 1
)
SELECT (SELECT count(*) FROM moved)::int AS moved, (SELECT count(*) FROM merged)::int AS buckets`;

const dailyRetentionSql = `DELETE FROM recipe_price_daily
WHERE ctid IN (
  SELECT ctid FROM recipe_price_daily
  WHERE bucket_start < now() - make_interval(days => $1::int)
  ORDER BY bucket_start
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)`;

export type PriceHistoryBucket = {
  start: Date;
  firstObservedAt: Date;
  lastObservedAt: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  observations: number;
  craftCost: string | null;
  craftCostObservedAt: Date | null;
  minComparableSellers: number | null;
  lastComparableSellers: number | null;
};

export type PriceHistoryLatest = {
  currency: 'chaos' | 'divine';
  ask: string;
  observedAt: Date;
  comparableSellers: number | null;
  coverage: 'complete' | 'partial' | 'unknown' | null;
  craftCost: string | null;
  craftCostObservedAt: Date | null;
};

export type PriceHistoryWindowStats = {
  currency: 'chaos' | 'divine';
  firstObservedAt: Date;
  lastObservedAt: Date;
  open: string;
  close: string;
  observations: number;
};

export type PriceHistorySummary = {
  latest: PriceHistoryLatest;
  window: PriceHistoryWindowStats | null;
  excludedCurrencies: ('chaos' | 'divine')[];
};

export type PriceHistoryRepository = {
  compact(options: {
    batchSize: number;
    maxBatches?: number;
    dailyRetentionDays?: number;
    before?: Date;
  }): Promise<{ rolledUp: number; dailyDeleted: number; drained: boolean }>;
  backfill(): Promise<number>;
  readSummaries(input: {
    leagueId: string;
    range: PriceHistoryRange;
    now: Date;
    recipeId?: string;
  }): Promise<Map<string, PriceHistorySummary>>;
  readBuckets(input: {
    leagueId: string;
    recipeId: string;
    currency: 'chaos' | 'divine';
    range: PriceHistoryRange;
    now: Date;
  }): Promise<PriceHistoryBucket[]>;
};

/** Upper bound on returned buckets for any supported range. */
export const maximumPriceHistoryBuckets = 366;

export function createPriceHistoryRepository(
  pool: Pool,
): PriceHistoryRepository {
  return {
    async compact(options) {
      if (!Number.isInteger(options.batchSize) || options.batchSize < 1)
        throw new TypeError('batchSize must be a positive integer');
      const maxBatches = options.maxBatches ?? 100;
      const dailyDays = Math.min(
        priceHistoryRetention.dailyDays,
        Math.max(
          priceHistoryRetention.observationDays + 1,
          Math.floor(
            options.dailyRetentionDays ?? priceHistoryRetention.dailyDays,
          ),
        ),
      );
      const before = options.before ?? new Date();
      let rolledUp = 0;
      let dailyDeleted = 0;
      let drained = false;
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const rollup = await pool.query<{ moved: number }>(rollupSql, [
          before,
          priceHistoryRetention.observationDays,
          options.batchSize,
        ]);
        const moved = rollup.rows[0]?.moved ?? 0;
        rolledUp += moved;
        const deleted =
          (await pool.query(dailyRetentionSql, [dailyDays, options.batchSize]))
            .rowCount ?? 0;
        dailyDeleted += deleted;
        if (moved < options.batchSize && deleted < options.batchSize) {
          drained = true;
          break;
        }
      }
      return { rolledUp, dailyDeleted, drained };
    },
    async backfill() {
      return (await pool.query(priceObservationBackfillSql)).rowCount ?? 0;
    },
    async readSummaries({ leagueId, range, now, recipeId }) {
      const window = priceHistoryWindow(range, now);
      const includeDaily = priceHistoryRanges[range].bucketMs >= dayMs;
      const recipeFilter = recipeId ? 'AND r.id = $2' : '';
      const params: unknown[] = recipeId ? [leagueId, recipeId] : [leagueId];
      const [latest, costs, stats] = await Promise.all([
        pool.query<{
          recipe_id: string;
          currency: 'chaos' | 'divine';
          observed_at: Date;
          ask: string;
          comparable_sellers: number | null;
          coverage: PriceHistoryLatest['coverage'];
        }>(
          `SELECT DISTINCT ON (recipe_id) recipe_id, currency, observed_at, ask, comparable_sellers, coverage
           FROM (
             SELECT o.recipe_id, o.currency, o.observed_at, o.ask, o.comparable_sellers, o.coverage, o.id AS tiebreak
             FROM recipe_price_observations o
             JOIN recipes r ON r.id = o.recipe_id AND r.content_hash = o.recipe_content_hash AND r.active
             WHERE o.league_id = $1 AND o.observed_at <= now() + interval '${priceHistoryRetention.futureSkewMinutes} minutes' ${recipeFilter}
             UNION ALL
             SELECT d.recipe_id, d.currency, d.last_observed_at, d.close_ask, d.last_comparable_sellers, NULL, 0
             FROM recipe_price_daily d
             JOIN recipes r ON r.id = d.recipe_id AND r.content_hash = d.recipe_content_hash AND r.active
             WHERE d.league_id = $1 ${recipeFilter}
           ) latest
           ORDER BY recipe_id, observed_at DESC, tiebreak DESC`,
          params,
        ),
        pool.query<{
          recipe_id: string;
          currency: string;
          craft_cost: string;
          observed_at: Date;
        }>(
          `SELECT DISTINCT ON (recipe_id, currency) recipe_id, currency, craft_cost, observed_at
           FROM (
             SELECT o.recipe_id, o.currency, o.craft_cost, o.observed_at, o.id AS tiebreak
             FROM recipe_price_observations o
             JOIN recipes r ON r.id = o.recipe_id AND r.content_hash = o.recipe_content_hash AND r.active
             WHERE o.league_id = $1 AND o.craft_cost IS NOT NULL ${recipeFilter}
             UNION ALL
             SELECT d.recipe_id, d.currency, d.craft_cost, d.craft_cost_observed_at, 0
             FROM recipe_price_daily d
             JOIN recipes r ON r.id = d.recipe_id AND r.content_hash = d.recipe_content_hash AND r.active
             WHERE d.league_id = $1 AND d.craft_cost IS NOT NULL ${recipeFilter}
           ) costs
           ORDER BY recipe_id, currency, observed_at DESC, tiebreak DESC`,
          params,
        ),
        pool.query<{
          recipe_id: string;
          currency: 'chaos' | 'divine';
          first_observed_at: Date;
          last_observed_at: Date;
          open: string;
          close: string;
          observations: number;
        }>(
          `SELECT recipe_id, currency,
             min(first_at) AS first_observed_at,
             max(last_at) AS last_observed_at,
             (array_agg(open_ask ORDER BY first_at, tiebreak))[1] AS open,
             (array_agg(close_ask ORDER BY last_at DESC, tiebreak DESC))[1] AS close,
             sum(cnt)::int AS observations
           FROM (
             SELECT o.recipe_id, o.currency, o.observed_at AS first_at, o.observed_at AS last_at,
               o.ask AS open_ask, o.ask AS close_ask, 1 AS cnt, o.id AS tiebreak
             FROM recipe_price_observations o
             JOIN recipes r ON r.id = o.recipe_id AND r.content_hash = o.recipe_content_hash AND r.active
             WHERE o.league_id = $1 AND o.observed_at >= $${params.length + 1} AND o.observed_at <= $${params.length + 2} ${recipeFilter}
             UNION ALL
             SELECT d.recipe_id, d.currency, d.first_observed_at, d.last_observed_at,
               d.open_ask, d.close_ask, d.observation_count, 0
             FROM recipe_price_daily d
             JOIN recipes r ON r.id = d.recipe_id AND r.content_hash = d.recipe_content_hash AND r.active
             WHERE $${params.length + 3}::boolean AND d.league_id = $1
               AND d.bucket_start >= $${params.length + 1} AND d.bucket_start <= $${params.length + 2} ${recipeFilter}
           ) rows
           GROUP BY recipe_id, currency`,
          [...params, window.start, window.end, includeDaily],
        ),
      ]);
      const costsBySeries = new Map(
        costs.rows.map((row) => [`${row.recipe_id}\0${row.currency}`, row]),
      );
      const statsByRecipe = new Map<string, typeof stats.rows>();
      for (const row of stats.rows) {
        const group = statsByRecipe.get(row.recipe_id);
        if (group) group.push(row);
        else statsByRecipe.set(row.recipe_id, [row]);
      }
      const summaries = new Map<string, PriceHistorySummary>();
      for (const row of latest.rows) {
        const cost = costsBySeries.get(`${row.recipe_id}\0${row.currency}`);
        const windowRows = statsByRecipe.get(row.recipe_id) ?? [];
        const current = windowRows.find((s) => s.currency === row.currency);
        summaries.set(row.recipe_id, {
          latest: {
            currency: row.currency,
            ask: row.ask,
            observedAt: row.observed_at,
            comparableSellers: row.comparable_sellers,
            coverage: row.coverage,
            craftCost: cost?.craft_cost ?? null,
            craftCostObservedAt: cost?.observed_at ?? null,
          },
          window: current
            ? {
                currency: current.currency,
                firstObservedAt: current.first_observed_at,
                lastObservedAt: current.last_observed_at,
                open: current.open,
                close: current.close,
                observations: current.observations,
              }
            : null,
          excludedCurrencies: windowRows
            .filter((s) => s.currency !== row.currency)
            .map((s) => s.currency),
        });
      }
      return summaries;
    },
    async readBuckets({ leagueId, recipeId, currency, range, now }) {
      const window = priceHistoryWindow(range, now);
      const { bucketInterval, bucketMs } = priceHistoryRanges[range];
      const result = await pool.query<{
        start: Date;
        first_observed_at: Date;
        last_observed_at: Date;
        open: string;
        high: string;
        low: string;
        close: string;
        observations: number;
        craft_cost: string | null;
        craft_cost_observed_at: Date | null;
        min_comparable_sellers: number | null;
        last_comparable_sellers: number | null;
      }>(
        `SELECT bucket_start AS start,
           min(first_at) AS first_observed_at,
           max(last_at) AS last_observed_at,
           (array_agg(open_ask ORDER BY first_at, tiebreak))[1] AS open,
           max(high_ask) AS high,
           min(low_ask) AS low,
           (array_agg(close_ask ORDER BY last_at DESC, tiebreak DESC))[1] AS close,
           sum(cnt)::int AS observations,
           (array_agg(craft_cost ORDER BY cost_at DESC, tiebreak DESC) FILTER (WHERE craft_cost IS NOT NULL))[1] AS craft_cost,
           max(cost_at) AS craft_cost_observed_at,
           min(min_sellers) AS min_comparable_sellers,
           (array_agg(last_sellers ORDER BY last_at DESC, tiebreak DESC))[1] AS last_comparable_sellers
         FROM (
           SELECT date_bin($5::interval, o.observed_at, ${bucketOriginSql}) AS bucket_start,
             o.observed_at AS first_at, o.observed_at AS last_at,
             o.ask AS open_ask, o.ask AS high_ask, o.ask AS low_ask, o.ask AS close_ask, 1 AS cnt,
             o.craft_cost, CASE WHEN o.craft_cost IS NOT NULL THEN o.observed_at END AS cost_at,
             o.comparable_sellers AS min_sellers, o.comparable_sellers AS last_sellers, o.id AS tiebreak
           FROM recipe_price_observations o
           JOIN recipes r ON r.id = o.recipe_id AND r.content_hash = o.recipe_content_hash AND r.active
           WHERE o.recipe_id = $1 AND o.league_id = $2 AND o.currency = $3
             AND o.observed_at >= $4 AND o.observed_at <= $6
           UNION ALL
           SELECT date_bin($5::interval, d.bucket_start, ${bucketOriginSql}),
             d.first_observed_at, d.last_observed_at,
             d.open_ask, d.high_ask, d.low_ask, d.close_ask, d.observation_count,
             d.craft_cost, d.craft_cost_observed_at,
             d.min_comparable_sellers, d.last_comparable_sellers, 0
           FROM recipe_price_daily d
           JOIN recipes r ON r.id = d.recipe_id AND r.content_hash = d.recipe_content_hash AND r.active
           WHERE $7::boolean AND d.recipe_id = $1 AND d.league_id = $2 AND d.currency = $3
             AND d.bucket_start >= $4 AND d.bucket_start <= $6
         ) rows
         GROUP BY bucket_start
         ORDER BY bucket_start
         LIMIT ${maximumPriceHistoryBuckets}`,
        [
          recipeId,
          leagueId,
          currency,
          window.start,
          bucketInterval,
          window.end,
          bucketMs >= dayMs,
        ],
      );
      return result.rows.map((row) => ({
        start: row.start,
        firstObservedAt: row.first_observed_at,
        lastObservedAt: row.last_observed_at,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        observations: row.observations,
        craftCost: row.craft_cost,
        craftCostObservedAt: row.craft_cost_observed_at,
        minComparableSellers: row.min_comparable_sellers,
        lastComparableSellers: row.last_comparable_sellers,
      }));
    },
  };
}
