CREATE TABLE "market_economy_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"league" text NOT NULL,
	"category" text NOT NULL,
	"payload_hash" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"summary" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "market_economy_snapshots_category_check" CHECK ("market_economy_snapshots"."category" in ('BaseType', 'Currency', 'Essence', 'Fossil', 'Resonator'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "market_economy_snapshots_observation_uq" ON "market_economy_snapshots" USING btree ("league","category","payload_hash","captured_at");--> statement-breakpoint
CREATE INDEX "market_economy_snapshots_time_idx" ON "market_economy_snapshots" USING btree ("captured_at");