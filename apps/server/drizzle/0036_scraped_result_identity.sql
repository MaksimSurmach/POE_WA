SET LOCAL lock_timeout = '3s';--> statement-breakpoint
DROP INDEX "run_requests_active_scope_recipe_uq";--> statement-breakpoint
ALTER TABLE "recipe_results" ADD COLUMN "scraped_identity" text;--> statement-breakpoint
CREATE UNIQUE INDEX "run_requests_active_scope_recipe_uq" ON "run_requests" USING btree ("scope",coalesce("recipe_id", ''),coalesce("scraped_item_id"::text || ':' || "scraped_item_revision"::text, ''),coalesce("schedule_key", '')) WHERE "run_requests"."state" in ('queued', 'running');