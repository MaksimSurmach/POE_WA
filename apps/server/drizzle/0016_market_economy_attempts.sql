CREATE TABLE "market_economy_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"league" text NOT NULL,
	"category" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" text NOT NULL,
	"cache_status" text,
	"error_code" text,
	"snapshot_id" uuid,
	CONSTRAINT "market_economy_attempts_status_check" CHECK ("market_economy_attempts"."status" in ('running', 'succeeded', 'failed')),
	CONSTRAINT "market_economy_attempts_cache_check" CHECK ("market_economy_attempts"."cache_status" is null or "market_economy_attempts"."cache_status" in ('fetched', 'hit', 'revalidated'))
);
--> statement-breakpoint
ALTER TABLE "market_economy_attempts" ADD CONSTRAINT "market_economy_attempts_snapshot_id_market_economy_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."market_economy_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_economy_attempts_time_idx" ON "market_economy_attempts" USING btree ("started_at");