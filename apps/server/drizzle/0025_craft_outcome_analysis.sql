CREATE TABLE "craft_outcome_models" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipe_id" text NOT NULL,
	"recipe_content_hash" text NOT NULL,
	"target_signature" text NOT NULL,
	"league_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "craft_outcome_models_revision_check" CHECK ("craft_outcome_models"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "craft_risk_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"model_id" uuid NOT NULL,
	"recipe_id" text NOT NULL,
	"recipe_content_hash" text NOT NULL,
	"league_id" uuid NOT NULL,
	"calculation_version" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" text NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"error" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "craft_risk_runs_status_check" CHECK ("craft_risk_runs"."status" in ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
	CONSTRAINT "craft_risk_runs_progress_check" CHECK ("craft_risk_runs"."progress" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "craft_outcome_models" ADD CONSTRAINT "craft_outcome_models_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_outcome_models" ADD CONSTRAINT "craft_outcome_models_league_id_poe_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."poe_leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_risk_runs" ADD CONSTRAINT "craft_risk_runs_model_id_craft_outcome_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."craft_outcome_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_risk_runs" ADD CONSTRAINT "craft_risk_runs_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_risk_runs" ADD CONSTRAINT "craft_risk_runs_league_id_poe_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."poe_leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "craft_outcome_models_revision_uq" ON "craft_outcome_models" USING btree ("recipe_id","recipe_content_hash","league_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "craft_outcome_models_idempotency_uq" ON "craft_outcome_models" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "craft_risk_runs_idempotency_uq" ON "craft_risk_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "craft_risk_runs_queue_idx" ON "craft_risk_runs" USING btree ("created_at") WHERE "craft_risk_runs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "craft_risk_runs_model_idx" ON "craft_risk_runs" USING btree ("model_id","created_at");