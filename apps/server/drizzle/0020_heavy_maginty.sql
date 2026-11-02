ALTER TABLE "market_collection_runs" ADD COLUMN "heartbeat_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "market_collection_runs" SET "heartbeat_at" = "started_at";
--> statement-breakpoint
ALTER TABLE "market_collection_runs" ALTER COLUMN "heartbeat_at" SET NOT NULL;
