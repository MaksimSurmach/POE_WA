CREATE TABLE "craft_allocation_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"league_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "craft_signal_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"context_key" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "craft_signal_states" (
	"context_key" text PRIMARY KEY NOT NULL,
	"recipe_id" text NOT NULL,
	"recipe_content_hash" text NOT NULL,
	"league_id" uuid NOT NULL,
	"target_signature" text NOT NULL,
	"document" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "craft_allocation_plans" ADD CONSTRAINT "craft_allocation_plans_league_id_poe_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."poe_leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_signal_history" ADD CONSTRAINT "craft_signal_history_context_key_craft_signal_states_context_key_fk" FOREIGN KEY ("context_key") REFERENCES "public"."craft_signal_states"("context_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_signal_states" ADD CONSTRAINT "craft_signal_states_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_signal_states" ADD CONSTRAINT "craft_signal_states_league_id_poe_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."poe_leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "craft_allocation_plans_idempotency_uq" ON "craft_allocation_plans" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "craft_allocation_plans_league_idx" ON "craft_allocation_plans" USING btree ("league_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "craft_signal_history_evidence_uq" ON "craft_signal_history" USING btree ("context_key","evidence_hash");--> statement-breakpoint
CREATE INDEX "craft_signal_history_context_idx" ON "craft_signal_history" USING btree ("context_key","created_at");--> statement-breakpoint
CREATE INDEX "craft_signal_states_league_idx" ON "craft_signal_states" USING btree ("league_id","updated_at");