CREATE TABLE "aggregated_observations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_query_id" uuid NOT NULL,
	"refresh_cycle_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"sample_size" integer NOT NULL,
	"currency" text NOT NULL,
	"cheapest_price" numeric(20, 8) NOT NULL,
	"nth_price" numeric(20, 8),
	"median_top_n_price" numeric(20, 8),
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aggregated_observations_sample_size_check" CHECK ("aggregated_observations"."sample_size" >= 0),
	CONSTRAINT "aggregated_observations_prices_check" CHECK ("aggregated_observations"."cheapest_price" >= 0 and ("aggregated_observations"."nth_price" is null or "aggregated_observations"."nth_price" >= 0) and ("aggregated_observations"."median_top_n_price" is null or "aggregated_observations"."median_top_n_price" >= 0))
);
--> statement-breakpoint
CREATE TABLE "catalog_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"published_cycle_id" uuid,
	"previous_cycle_id" uuid,
	"revision" bigint DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_state_singleton_check" CHECK ("catalog_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"refresh_cycle_id" uuid,
	"recipe_id" text,
	"market_query_id" uuid,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_kind_check" CHECK ("jobs"."kind" in ('recipe_refresh', 'catalog_publish', 'snapshot_cleanup')),
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('queued', 'running', 'retry', 'succeeded', 'failed')),
	CONSTRAINT "jobs_attempts_check" CHECK ("jobs"."attempts" >= 0 and "jobs"."max_attempts" > 0 and "jobs"."attempts" <= "jobs"."max_attempts")
);
--> statement-breakpoint
CREATE TABLE "market_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" text NOT NULL,
	"provider" text NOT NULL,
	"canonical_hash" text NOT NULL,
	"query" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"market_query_id" uuid NOT NULL,
	"refresh_cycle_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"provider_status" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raw_snapshots_provider_status_check" CHECK ("raw_snapshots"."provider_status" between 100 and 599)
);
--> statement-breakpoint
CREATE TABLE "recipe_evaluations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"recipe_id" text NOT NULL,
	"refresh_cycle_id" uuid NOT NULL,
	"observation_id" bigint,
	"source_snapshot_dedupe_key" text,
	"status" text NOT NULL,
	"expected_craft_cost" numeric(20, 8),
	"estimated_sale_price" numeric(20, 8),
	"profit" numeric(20, 8),
	"margin_percent" numeric(12, 6),
	"confidence" text,
	"error_code" text,
	"evaluated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_evaluations_status_check" CHECK ("recipe_evaluations"."status" in ('success', 'stale', 'partial', 'error')),
	CONSTRAINT "recipe_evaluations_confidence_check" CHECK ("recipe_evaluations"."confidence" is null or "recipe_evaluations"."confidence" in ('low', 'medium', 'high')),
	CONSTRAINT "recipe_evaluations_prices_check" CHECK (("recipe_evaluations"."expected_craft_cost" is null or "recipe_evaluations"."expected_craft_cost" >= 0) and ("recipe_evaluations"."estimated_sale_price" is null or "recipe_evaluations"."estimated_sale_price" >= 0))
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" text PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"craft_method" text NOT NULL,
	"game_version" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"guide_markdown" text NOT NULL,
	"definition" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"total_recipes" integer DEFAULT 0 NOT NULL,
	"completed_recipes" integer DEFAULT 0 NOT NULL,
	"failed_recipes" integer DEFAULT 0 NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_cycles_status_check" CHECK ("refresh_cycles"."status" in ('queued', 'running', 'published', 'failed', 'superseded')),
	CONSTRAINT "refresh_cycles_counts_check" CHECK ("refresh_cycles"."total_recipes" >= 0 and "refresh_cycles"."completed_recipes" >= 0 and "refresh_cycles"."failed_recipes" >= 0 and "refresh_cycles"."completed_recipes" + "refresh_cycles"."failed_recipes" <= "refresh_cycles"."total_recipes")
);
--> statement-breakpoint
ALTER TABLE "aggregated_observations" ADD CONSTRAINT "aggregated_observations_market_query_id_market_queries_id_fk" FOREIGN KEY ("market_query_id") REFERENCES "public"."market_queries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aggregated_observations" ADD CONSTRAINT "aggregated_observations_refresh_cycle_id_refresh_cycles_id_fk" FOREIGN KEY ("refresh_cycle_id") REFERENCES "public"."refresh_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_state" ADD CONSTRAINT "catalog_state_published_cycle_id_refresh_cycles_id_fk" FOREIGN KEY ("published_cycle_id") REFERENCES "public"."refresh_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_state" ADD CONSTRAINT "catalog_state_previous_cycle_id_refresh_cycles_id_fk" FOREIGN KEY ("previous_cycle_id") REFERENCES "public"."refresh_cycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_refresh_cycle_id_refresh_cycles_id_fk" FOREIGN KEY ("refresh_cycle_id") REFERENCES "public"."refresh_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_market_query_id_market_queries_id_fk" FOREIGN KEY ("market_query_id") REFERENCES "public"."market_queries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_queries" ADD CONSTRAINT "market_queries_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_snapshots" ADD CONSTRAINT "raw_snapshots_market_query_id_market_queries_id_fk" FOREIGN KEY ("market_query_id") REFERENCES "public"."market_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_snapshots" ADD CONSTRAINT "raw_snapshots_refresh_cycle_id_refresh_cycles_id_fk" FOREIGN KEY ("refresh_cycle_id") REFERENCES "public"."refresh_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_evaluations" ADD CONSTRAINT "recipe_evaluations_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_evaluations" ADD CONSTRAINT "recipe_evaluations_refresh_cycle_id_refresh_cycles_id_fk" FOREIGN KEY ("refresh_cycle_id") REFERENCES "public"."refresh_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_evaluations" ADD CONSTRAINT "recipe_evaluations_observation_id_aggregated_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."aggregated_observations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aggregated_observations_query_cycle_uq" ON "aggregated_observations" USING btree ("market_query_id","refresh_cycle_id");--> statement-breakpoint
CREATE INDEX "aggregated_observations_query_observed_at_idx" ON "aggregated_observations" USING btree ("market_query_id","observed_at");--> statement-breakpoint
CREATE INDEX "aggregated_observations_refresh_cycle_id_idx" ON "aggregated_observations" USING btree ("refresh_cycle_id");--> statement-breakpoint
CREATE INDEX "aggregated_observations_observed_at_idx" ON "aggregated_observations" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "catalog_state_published_cycle_id_idx" ON "catalog_state" USING btree ("published_cycle_id");--> statement-breakpoint
CREATE INDEX "catalog_state_previous_cycle_id_idx" ON "catalog_state" USING btree ("previous_cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_key_uq" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_pending_run_after_idx" ON "jobs" USING btree ("status","priority" DESC NULLS LAST,"run_after") WHERE "jobs"."status" in ('queued', 'retry');--> statement-breakpoint
CREATE INDEX "jobs_running_locked_at_idx" ON "jobs" USING btree ("locked_at") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "jobs_refresh_cycle_id_idx" ON "jobs" USING btree ("refresh_cycle_id");--> statement-breakpoint
CREATE INDEX "jobs_recipe_id_idx" ON "jobs" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "jobs_market_query_id_idx" ON "jobs" USING btree ("market_query_id");--> statement-breakpoint
CREATE UNIQUE INDEX "market_queries_canonical_hash_uq" ON "market_queries" USING btree ("canonical_hash");--> statement-breakpoint
CREATE INDEX "market_queries_recipe_id_idx" ON "market_queries" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "market_queries_active_provider_idx" ON "market_queries" USING btree ("provider","updated_at") WHERE "market_queries"."active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "raw_snapshots_dedupe_key_uq" ON "raw_snapshots" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "raw_snapshots_market_query_captured_at_idx" ON "raw_snapshots" USING btree ("market_query_id","captured_at");--> statement-breakpoint
CREATE INDEX "raw_snapshots_refresh_cycle_id_idx" ON "raw_snapshots" USING btree ("refresh_cycle_id");--> statement-breakpoint
CREATE INDEX "raw_snapshots_expires_at_idx" ON "raw_snapshots" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_evaluations_recipe_cycle_uq" ON "recipe_evaluations" USING btree ("recipe_id","refresh_cycle_id");--> statement-breakpoint
CREATE INDEX "recipe_evaluations_recipe_evaluated_at_idx" ON "recipe_evaluations" USING btree ("recipe_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "recipe_evaluations_refresh_cycle_id_idx" ON "recipe_evaluations" USING btree ("refresh_cycle_id");--> statement-breakpoint
CREATE INDEX "recipe_evaluations_observation_id_idx" ON "recipe_evaluations" USING btree ("observation_id");--> statement-breakpoint
CREATE INDEX "recipe_evaluations_status_evaluated_at_idx" ON "recipe_evaluations" USING btree ("status","evaluated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_content_hash_uq" ON "recipes" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "recipes_active_category_updated_at_idx" ON "recipes" USING btree ("category","updated_at") WHERE "recipes"."active" = true;--> statement-breakpoint
CREATE INDEX "refresh_cycles_status_requested_at_idx" ON "refresh_cycles" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "refresh_cycles_published_at_idx" ON "refresh_cycles" USING btree ("published_at") WHERE "refresh_cycles"."published_at" is not null;