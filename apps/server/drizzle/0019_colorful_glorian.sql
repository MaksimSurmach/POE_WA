CREATE TABLE "market_collection_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_id" uuid NOT NULL,
	"target_digest" text NOT NULL,
	"league" text NOT NULL,
	"patch" text NOT NULL,
	"status" text NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	CONSTRAINT "market_collection_runs_status_check" CHECK ("market_collection_runs"."status" in ('running', 'succeeded', 'empty', 'partial', 'blocked', 'rate_limited', 'failed', 'cancelled')),
	CONSTRAINT "market_collection_runs_payload_object" CHECK (jsonb_typeof("market_collection_runs"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "market_collection_settings" (
	"target_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"interval_minutes" integer DEFAULT 60 NOT NULL,
	"next_run_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "market_collection_settings_interval_check" CHECK ("market_collection_settings"."interval_minutes" between 5 and 1440),
	CONSTRAINT "market_collection_settings_payload_object" CHECK (jsonb_typeof("market_collection_settings"."payload") = 'object')
);
--> statement-breakpoint
ALTER TABLE "market_collection_runs" ADD CONSTRAINT "market_collection_runs_target_id_market_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."market_targets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_collection_settings" ADD CONSTRAINT "market_collection_settings_target_id_market_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."market_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_collection_runs_target_time_idx" ON "market_collection_runs" USING btree ("target_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "market_collection_runs_single_active_uq" ON "market_collection_runs" USING btree ("target_id") WHERE "market_collection_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "market_collection_settings_due_idx" ON "market_collection_settings" USING btree ("enabled","paused","next_run_at");