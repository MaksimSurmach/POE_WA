CREATE TABLE "market_admin_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_admin_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"recipe_id" text,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "market_admin_runs_status_check" CHECK ("market_admin_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped')),
	CONSTRAINT "market_admin_runs_scope_check" CHECK ("market_admin_runs"."scope" in ('all', 'economy', 'recipe'))
);
--> statement-breakpoint
CREATE TABLE "market_admin_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_admin_settings_singleton" CHECK ("market_admin_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "market_worker_health" (
	"id" text PRIMARY KEY NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"settings_version" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "market_admin_runs_single_active" ON "market_admin_runs" USING btree ((1)) WHERE "market_admin_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "market_admin_runs_requested_idx" ON "market_admin_runs" USING btree ("requested_at");