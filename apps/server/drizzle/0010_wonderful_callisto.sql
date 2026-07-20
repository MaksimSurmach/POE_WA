DELETE FROM "jobs";--> statement-breakpoint
DELETE FROM "catalog_state";--> statement-breakpoint
DELETE FROM "recipe_evaluations";--> statement-breakpoint
DELETE FROM "raw_snapshots";--> statement-breakpoint
DELETE FROM "aggregated_observations";--> statement-breakpoint
DELETE FROM "refresh_cycles";--> statement-breakpoint
ALTER TABLE "aggregated_observations" ADD COLUMN "league_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "raw_snapshots" ADD COLUMN "league_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "recipe_evaluations" ADD COLUMN "league_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_cycles" ADD COLUMN "league_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "aggregated_observations" ADD CONSTRAINT "aggregated_observations_league_id_poe_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."poe_leagues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_snapshots" ADD CONSTRAINT "raw_snapshots_league_id_poe_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."poe_leagues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_evaluations" ADD CONSTRAINT "recipe_evaluations_league_id_poe_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."poe_leagues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_cycles" ADD CONSTRAINT "refresh_cycles_league_id_poe_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."poe_leagues"("id") ON DELETE restrict ON UPDATE no action;
