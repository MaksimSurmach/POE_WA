CREATE TABLE "recipe_price_daily" (
	"recipe_id" text NOT NULL,
	"recipe_content_hash" text NOT NULL,
	"league_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"open_ask" numeric(20, 8) NOT NULL,
	"high_ask" numeric(20, 8) NOT NULL,
	"low_ask" numeric(20, 8) NOT NULL,
	"close_ask" numeric(20, 8) NOT NULL,
	"observation_count" integer NOT NULL,
	"craft_cost" numeric(20, 8),
	"craft_cost_observed_at" timestamp with time zone,
	"min_comparable_sellers" integer,
	"last_comparable_sellers" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_price_daily_pk" PRIMARY KEY("recipe_id","recipe_content_hash","league_id","currency","bucket_start"),
	CONSTRAINT "recipe_price_daily_currency_check" CHECK ("recipe_price_daily"."currency" in ('chaos', 'divine')),
	CONSTRAINT "recipe_price_daily_ohlc_check" CHECK ("recipe_price_daily"."low_ask" >= 0 and "recipe_price_daily"."low_ask" <= "recipe_price_daily"."open_ask" and "recipe_price_daily"."low_ask" <= "recipe_price_daily"."close_ask" and "recipe_price_daily"."high_ask" >= "recipe_price_daily"."open_ask" and "recipe_price_daily"."high_ask" >= "recipe_price_daily"."close_ask"),
	CONSTRAINT "recipe_price_daily_times_check" CHECK ("recipe_price_daily"."first_observed_at" <= "recipe_price_daily"."last_observed_at" and "recipe_price_daily"."observation_count" > 0),
	CONSTRAINT "recipe_price_daily_cost_check" CHECK (("recipe_price_daily"."craft_cost" is null) = ("recipe_price_daily"."craft_cost_observed_at" is null) and ("recipe_price_daily"."craft_cost" is null or "recipe_price_daily"."craft_cost" >= 0))
);
--> statement-breakpoint
CREATE TABLE "recipe_price_observations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"recipe_id" text NOT NULL,
	"recipe_content_hash" text NOT NULL,
	"league_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"source_snapshot_dedupe_key" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"ask" numeric(20, 8) NOT NULL,
	"craft_cost" numeric(20, 8),
	"comparable_sellers" integer,
	"coverage" text,
	"sorted_sample_complete" boolean,
	"evaluation_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_price_observations_currency_check" CHECK ("recipe_price_observations"."currency" in ('chaos', 'divine')),
	CONSTRAINT "recipe_price_observations_values_check" CHECK ("recipe_price_observations"."ask" >= 0 and ("recipe_price_observations"."craft_cost" is null or "recipe_price_observations"."craft_cost" >= 0) and ("recipe_price_observations"."comparable_sellers" is null or "recipe_price_observations"."comparable_sellers" >= 0)),
	CONSTRAINT "recipe_price_observations_coverage_check" CHECK ("recipe_price_observations"."coverage" is null or "recipe_price_observations"."coverage" in ('complete', 'partial', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "recipe_price_daily" ADD CONSTRAINT "recipe_price_daily_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_price_daily" ADD CONSTRAINT "recipe_price_daily_league_id_poe_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."poe_leagues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_price_observations" ADD CONSTRAINT "recipe_price_observations_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_price_observations" ADD CONSTRAINT "recipe_price_observations_league_id_poe_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."poe_leagues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipe_price_daily_league_bucket_idx" ON "recipe_price_daily" USING btree ("league_id","bucket_start");--> statement-breakpoint
CREATE INDEX "recipe_price_daily_bucket_idx" ON "recipe_price_daily" USING btree ("bucket_start");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_price_observations_source_uq" ON "recipe_price_observations" USING btree ("recipe_id","recipe_content_hash","league_id","currency","source_snapshot_dedupe_key");--> statement-breakpoint
CREATE INDEX "recipe_price_observations_series_idx" ON "recipe_price_observations" USING btree ("recipe_id","recipe_content_hash","league_id","currency","observed_at");--> statement-breakpoint
CREATE INDEX "recipe_price_observations_league_observed_idx" ON "recipe_price_observations" USING btree ("league_id","observed_at");--> statement-breakpoint
CREATE INDEX "recipe_price_observations_observed_at_idx" ON "recipe_price_observations" USING btree ("observed_at");--> statement-breakpoint
CREATE VIEW "public"."recipe_price_observation_candidates" AS (select
  e.id as evaluation_id,
  e.recipe_id,
  e.method_cost->>'recipeContentHash' as recipe_content_hash,
  e.league_id,
  e.currency,
  e.source_snapshot_dedupe_key,
  case
    when e.method_cost->'source'->>'capturedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      and pg_input_is_valid(e.method_cost->'source'->>'capturedAt', 'timestamptz')
    then (e.method_cost->'source'->>'capturedAt')::timestamptz
  end as observed_at,
  e.estimated_sale_price as ask,
  case
    when e.expected_craft_cost is not null
      and coalesce(e.method_cost->'expectedCost'->>'currency', e.currency) = e.currency
      and e.method_cost->>'expiresAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      and pg_input_is_valid(e.method_cost->>'expiresAt', 'timestamptz')
    then case
      when (e.method_cost->>'expiresAt')::timestamptz > e.evaluated_at
      then e.expected_craft_cost
    end
  end as craft_cost,
  case
    when jsonb_typeof(e.method_cost->'source'->'sampleSize') = 'number'
      and pg_input_is_valid(e.method_cost->'source'->>'sampleSize', 'integer')
    then case
      when (e.method_cost->'source'->>'sampleSize')::integer >= 0
      then (e.method_cost->'source'->>'sampleSize')::integer
    end
  end as comparable_sellers,
  case
    when e.method_cost->'source'->>'coverage' in ('complete', 'partial', 'unknown')
    then e.method_cost->'source'->>'coverage'
  end as coverage,
  case
    when jsonb_typeof(e.method_cost->'source'->'sortedSampleComplete') = 'boolean'
    then (e.method_cost->'source'->>'sortedSampleComplete')::boolean
  end as sorted_sample_complete,
  e.evaluated_at
from recipe_evaluations e
where e.status in ('success', 'partial')
  and e.estimated_sale_price is not null
  and e.estimated_sale_price >= 0
  and e.currency in ('chaos', 'divine')
  and e.source_snapshot_dedupe_key is not null
  and jsonb_typeof(e.method_cost) = 'object'
  and jsonb_typeof(e.method_cost->'recipeContentHash') = 'string');--> statement-breakpoint
-- One-time backfill of usable saved evaluations (idempotent; see docs/database.md).
INSERT INTO recipe_price_observations (recipe_id, recipe_content_hash, league_id, currency,
  source_snapshot_dedupe_key, observed_at, ask, craft_cost, comparable_sellers,
  coverage, sorted_sample_complete, evaluation_id)
SELECT DISTINCT ON (c.recipe_id, c.recipe_content_hash, c.league_id, c.currency, c.source_snapshot_dedupe_key)
  c.recipe_id, c.recipe_content_hash, c.league_id, c.currency,
  c.source_snapshot_dedupe_key, c.observed_at, c.ask, c.craft_cost,
  c.comparable_sellers, c.coverage, c.sorted_sample_complete, c.evaluation_id
FROM recipe_price_observation_candidates c
WHERE c.observed_at IS NOT NULL
  AND c.observed_at <= c.evaluated_at
  AND c.observed_at <= now() + interval '5 minutes'
  AND c.observed_at >= now() - interval '730 days'
ORDER BY c.recipe_id, c.recipe_content_hash, c.league_id, c.currency, c.source_snapshot_dedupe_key, c.evaluated_at, c.evaluation_id
ON CONFLICT (recipe_id, recipe_content_hash, league_id, currency, source_snapshot_dedupe_key) DO NOTHING;
