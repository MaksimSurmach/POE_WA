CREATE TABLE "market_collection_checkpoints" (
	"provider" text NOT NULL,
	"realm" text NOT NULL,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_collection_checkpoints_provider_realm_pk" PRIMARY KEY("provider","realm")
);
--> statement-breakpoint
CREATE TABLE "market_collection_ownership" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"owner_instance_id" text,
	"owner_epoch" bigint DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	CONSTRAINT "market_collection_ownership_singleton_check" CHECK ("market_collection_ownership"."singleton"),
	CONSTRAINT "market_collection_ownership_epoch_check" CHECK ("market_collection_ownership"."owner_epoch" >= 0)
);
--> statement-breakpoint
CREATE TABLE "market_collection_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"claim_owner" text,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"run_id" uuid,
	"error_code" text,
	CONSTRAINT "market_collection_requests_state_check" CHECK ("market_collection_requests"."state" in ('queued','claimed','completed','cancelled')),
	CONSTRAINT "market_collection_requests_error_check" CHECK ("market_collection_requests"."error_code" is null or "market_collection_requests"."error_code" ~ '^[A-Z0-9_]{1,100}$')
);
--> statement-breakpoint
CREATE TABLE "market_collection_workers" (
	"instance_id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text NOT NULL,
	"active_runs" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	CONSTRAINT "market_collection_workers_state_check" CHECK ("market_collection_workers"."state" in ('starting','healthy','draining','unhealthy')),
	CONSTRAINT "market_collection_workers_active_runs_check" CHECK ("market_collection_workers"."active_runs" >= 0),
	CONSTRAINT "market_collection_workers_error_check" CHECK ("market_collection_workers"."last_error_code" is null or "market_collection_workers"."last_error_code" ~ '^[A-Z0-9_]{1,100}$')
);
--> statement-breakpoint
ALTER TABLE "market_collection_runs" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "market_collection_runs" ADD COLUMN "owner_epoch" bigint;--> statement-breakpoint
ALTER TABLE "market_research_snapshots" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "market_research_snapshots" ADD COLUMN "owner_epoch" bigint;--> statement-breakpoint
ALTER TABLE "market_collection_requests" ADD CONSTRAINT "market_collection_requests_target_id_market_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."market_targets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_collection_requests" ADD CONSTRAINT "market_collection_requests_run_id_market_collection_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."market_collection_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_collection_requests_queue_idx" ON "market_collection_requests" USING btree ("state","requested_at") WHERE "market_collection_requests"."state" = 'queued';--> statement-breakpoint
CREATE INDEX "market_collection_requests_target_idx" ON "market_collection_requests" USING btree ("target_id","requested_at" DESC NULLS LAST);
--> statement-breakpoint
INSERT INTO market_collection_ownership(singleton) VALUES (true);
--> statement-breakpoint
CREATE FUNCTION market_collection_assert_write_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_owner text;
  current_epoch bigint;
  current_expiry timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'market_collection_runs' THEN
    IF TG_OP = 'INSERT' AND NEW.payload->>'sourceId' = 'manual-import' THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status <> 'running'
        AND (to_jsonb(NEW) - 'payload') = (to_jsonb(OLD) - 'payload')
        AND NEW.payload = jsonb_set(jsonb_set(OLD.payload - 'searchEvidence', '{listings}', '[]'::jsonb), '{rawAvailable}', 'false'::jsonb) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'market_research_snapshots' THEN
    IF NEW.summary->>'provenance' = 'manual_import' THEN
      IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND to_jsonb(NEW) = to_jsonb(OLD)) THEN
        RETURN NEW;
      END IF;
    END IF;
    IF TG_OP = 'UPDATE'
        AND (to_jsonb(NEW) - 'listings' - 'summary') = (to_jsonb(OLD) - 'listings' - 'summary')
        AND NEW.listings = '[]'::jsonb
        AND NEW.summary = jsonb_set(OLD.summary, '{rawAvailable}', 'false'::jsonb) THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT owner_instance_id, owner_epoch, lease_expires_at
    INTO current_owner, current_epoch, current_expiry
    FROM market_collection_ownership WHERE singleton FOR SHARE;
  IF NEW.runner_id IS NULL THEN
    IF current_owner IS NOT NULL AND current_expiry > now() THEN
      RAISE EXCEPTION 'Node collection write rejected while Go owner lease is active' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.owner_epoch IS NULL OR NEW.runner_id IS DISTINCT FROM current_owner
      OR NEW.owner_epoch IS DISTINCT FROM current_epoch OR current_expiry IS NULL OR current_expiry <= now() THEN
    RAISE EXCEPTION 'stale market collection owner epoch' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER market_collection_runs_owner_fence
  BEFORE INSERT OR UPDATE ON market_collection_runs
  FOR EACH ROW EXECUTE FUNCTION market_collection_assert_write_owner();
CREATE TRIGGER market_research_snapshots_owner_fence
  BEFORE INSERT OR UPDATE ON market_research_snapshots
  FOR EACH ROW EXECUTE FUNCTION market_collection_assert_write_owner();
