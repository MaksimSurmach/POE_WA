CREATE TABLE "factory_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipe_id" text NOT NULL,
	"league_id" uuid NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "factory_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"document" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factory_events_sequence_check" CHECK ("factory_events"."sequence" > 0 and "factory_events"."sequence" <= 2000)
);
--> statement-breakpoint
CREATE TABLE "factory_mutations" (
	"idempotency_key" uuid PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"result_version" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factory_mutations_version_check" CHECK ("factory_mutations"."result_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "factory_batches" ADD CONSTRAINT "factory_batches_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory_batches" ADD CONSTRAINT "factory_batches_league_id_poe_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."poe_leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory_events" ADD CONSTRAINT "factory_events_batch_id_factory_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."factory_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory_mutations" ADD CONSTRAINT "factory_mutations_batch_id_factory_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."factory_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "factory_batches_league_idx" ON "factory_batches" USING btree ("league_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "factory_events_sequence_uq" ON "factory_events" USING btree ("batch_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "factory_inventory_identity_uq" ON "factory_events" USING btree (("document"->'payload'->>'itemId')) WHERE "factory_events"."document"->'payload'->>'type' = 'produce';