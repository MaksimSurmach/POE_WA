CREATE TABLE "captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"reported_total" integer NOT NULL,
	"fetched" integer NOT NULL,
	"complete" boolean NOT NULL,
	"partial_reason" text,
	"slices" integer NOT NULL,
	"fx_snapshot_id" uuid,
	"duration_ms" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collector_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"league_id" uuid,
	"payload" jsonb NOT NULL,
	"interval_minutes" integer NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone,
	"leased_until" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "collector_schedule_kind_check" CHECK ("collector_schedule"."kind" in ('trade-target', 'economy', 'league', 'retention')),
	CONSTRAINT "collector_schedule_interval_check" CHECK ("collector_schedule"."interval_minutes" > 0),
	CONSTRAINT "collector_schedule_attempt_check" CHECK ("collector_schedule"."attempt" >= 0)
);
--> statement-breakpoint
CREATE TABLE "collector_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_run_started_at" timestamp with time zone,
	"last_run_finished_at" timestamp with time zone,
	"last_run_status" text,
	"last_run_summary" jsonb,
	"blocked_reason" text,
	"session_checked_at" timestamp with time zone,
	CONSTRAINT "collector_state_singleton_check" CHECK ("collector_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "listing_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"schedule_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"capture_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"from_price_chaos" numeric(20, 8),
	"to_price_chaos" numeric(20, 8),
	"related_item_id" text,
	CONSTRAINT "listing_events_type_check" CHECK ("listing_events"."type" in ('first_seen', 'price_changed', 'missed', 'reappeared', 'gone', 'possible_relist'))
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"schedule_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"seller" text,
	"fingerprint" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"first_capture_id" uuid NOT NULL,
	"last_capture_id" uuid NOT NULL,
	"price_original" numeric(20, 8),
	"currency" text,
	"price_chaos" numeric(20, 8),
	"indexed_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"missed_complete_captures" integer DEFAULT 0 NOT NULL,
	"gone_at" timestamp with time zone,
	"item" jsonb NOT NULL,
	CONSTRAINT "listings_schedule_id_item_id_pk" PRIMARY KEY("schedule_id","item_id"),
	CONSTRAINT "listings_status_check" CHECK ("listings"."status" in ('active', 'missing', 'gone')),
	CONSTRAINT "listings_missed_complete_captures_check" CHECK ("listings"."missed_complete_captures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_results" (
	"recipe_id" text NOT NULL,
	"league_id" uuid NOT NULL,
	"recipe_content_hash" text NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "recipe_results_recipe_id_league_id_pk" PRIMARY KEY("recipe_id","league_id")
);
--> statement-breakpoint
CREATE TABLE "run_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"recipe_id" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"summary" jsonb,
	CONSTRAINT "run_requests_scope_recipe_check" CHECK (("run_requests"."scope" = 'all' and "run_requests"."recipe_id" is null)
        or ("run_requests"."scope" = 'recipe' and "run_requests"."recipe_id" is not null)),
	CONSTRAINT "run_requests_state_check" CHECK ("run_requests"."state" in ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_schedule_id_collector_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."collector_schedule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_schedule" ADD CONSTRAINT "collector_schedule_league_id_poe_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."poe_leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_events" ADD CONSTRAINT "listing_events_schedule_id_collector_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."collector_schedule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_events" ADD CONSTRAINT "listing_events_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_schedule_id_collector_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."collector_schedule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_first_capture_id_captures_id_fk" FOREIGN KEY ("first_capture_id") REFERENCES "public"."captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_last_capture_id_captures_id_fk" FOREIGN KEY ("last_capture_id") REFERENCES "public"."captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_results" ADD CONSTRAINT "recipe_results_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_results" ADD CONSTRAINT "recipe_results_league_id_poe_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."poe_leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_requests" ADD CONSTRAINT "run_requests_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "captures_schedule_time_uq" ON "captures" USING btree ("schedule_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "collector_schedule_kind_key_uq" ON "collector_schedule" USING btree ("kind","key");--> statement-breakpoint
CREATE INDEX "collector_schedule_enabled_due_idx" ON "collector_schedule" USING btree ("next_due_at") WHERE "collector_schedule"."enabled";--> statement-breakpoint
CREATE INDEX "listing_events_schedule_item_time_idx" ON "listing_events" USING btree ("schedule_id","item_id","at");--> statement-breakpoint
CREATE INDEX "listing_events_schedule_type_time_idx" ON "listing_events" USING btree ("schedule_id","type","at");--> statement-breakpoint
CREATE INDEX "listings_schedule_status_idx" ON "listings" USING btree ("schedule_id","status");--> statement-breakpoint
CREATE INDEX "listings_schedule_seller_fingerprint_idx" ON "listings" USING btree ("schedule_id","seller","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "run_requests_queued_scope_recipe_uq" ON "run_requests" USING btree ("scope",coalesce("recipe_id", '')) WHERE "run_requests"."state" = 'queued';