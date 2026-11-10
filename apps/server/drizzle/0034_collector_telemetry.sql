SET LOCAL lock_timeout = '3s';--> statement-breakpoint
CREATE TABLE "collector_telemetry_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text NOT NULL,
	"partial_reason" text,
	"measurements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "collector_telemetry_runs_outcome_check" CHECK ("collector_telemetry_runs"."outcome" in ('running', 'complete', 'partial', 'failed', 'interrupted', 'other'))
);
--> statement-breakpoint
DROP INDEX "run_requests_queued_scope_recipe_uq";--> statement-breakpoint
ALTER TABLE "collector_state" ADD COLUMN "telemetry_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collector_state" ADD COLUMN "telemetry_contacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collector_state" ADD COLUMN "telemetry_leader_pid" integer;--> statement-breakpoint
ALTER TABLE "collector_state" ADD COLUMN "telemetry_current" jsonb;--> statement-breakpoint
ALTER TABLE "collector_state" ADD COLUMN "telemetry_rate_limits" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "collector_telemetry_runs_started_idx" ON "collector_telemetry_runs" USING btree ("started_at");--> statement-breakpoint
-- The old API could enqueue the same scope while an earlier request was running.
WITH duplicates AS (
  SELECT id, row_number() OVER (
    PARTITION BY scope, coalesce(recipe_id, '')
    ORDER BY (state = 'running') DESC, requested_at, id
  ) AS rank
  FROM run_requests WHERE state IN ('queued', 'running')
)
UPDATE run_requests SET state = 'failed', finished_at = now(),
  summary = jsonb_build_object('error', 'COLLECTOR_REQUEST_SUPERSEDED')
WHERE id IN (SELECT id FROM duplicates WHERE rank > 1);
--> statement-breakpoint
CREATE UNIQUE INDEX "run_requests_active_scope_recipe_uq" ON "run_requests" USING btree ("scope",coalesce("recipe_id", '')) WHERE "run_requests"."state" in ('queued', 'running');
