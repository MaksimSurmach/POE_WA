SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "query_version" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "floor_chaos" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "observed_min_chaos" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "observed_max_chaos" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "fx_chaos_per_divine" numeric;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "first_missing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "unchanged_ask_since" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "captures_time_idx" ON "captures" USING btree ("captured_at","id");--> statement-breakpoint
CREATE INDEX "listing_events_capture_idx" ON "listing_events" USING btree ("capture_id");--> statement-breakpoint
CREATE INDEX "listing_events_time_idx" ON "listing_events" USING btree ("at","id");--> statement-breakpoint
CREATE INDEX "listings_first_capture_idx" ON "listings" USING btree ("first_capture_id");--> statement-breakpoint
CREATE INDEX "listings_last_capture_idx" ON "listings" USING btree ("last_capture_id");
