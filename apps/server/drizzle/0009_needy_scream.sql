CREATE TABLE "poe_leagues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game" text DEFAULT 'poe1' NOT NULL,
	"realm" text DEFAULT 'pc' NOT NULL,
	"ggg_id" text NOT NULL,
	"name" text NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"is_current" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poe_leagues_dates_check" CHECK ("poe_leagues"."end_at" is null or "poe_leagues"."start_at" is null or "poe_leagues"."end_at" >= "poe_leagues"."start_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "poe_leagues_game_realm_ggg_id_uq" ON "poe_leagues" USING btree ("game","realm","ggg_id");--> statement-breakpoint
CREATE UNIQUE INDEX "poe_leagues_one_current_uq" ON "poe_leagues" USING btree ("game","realm") WHERE "poe_leagues"."is_current" = true;
--> statement-breakpoint
INSERT INTO "poe_leagues" ("game", "realm", "ggg_id", "name", "is_current", "synced_at")
VALUES ('poe1', 'pc', 'Standard', 'Standard', true, now());
