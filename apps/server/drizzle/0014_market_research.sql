CREATE TABLE "market_research_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"data_kind" text NOT NULL,
	"currency" text NOT NULL,
	"summary" jsonb NOT NULL,
	"listings" jsonb NOT NULL,
	CONSTRAINT "market_research_snapshots_kind_check" CHECK ("market_research_snapshots"."data_kind" in ('observed', 'demo')),
	CONSTRAINT "market_research_snapshots_currency_check" CHECK ("market_research_snapshots"."currency" in ('chaos', 'divine')),
	CONSTRAINT "market_research_snapshots_count_check" CHECK (jsonb_typeof("market_research_snapshots"."listings") = 'array' and jsonb_array_length("market_research_snapshots"."listings") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "market_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"profile" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "market_targets_profile_object" CHECK (jsonb_typeof("market_targets"."profile") = 'object')
);
--> statement-breakpoint
ALTER TABLE "market_research_snapshots" ADD CONSTRAINT "market_research_snapshots_target_id_market_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."market_targets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_research_snapshots_digest_uq" ON "market_research_snapshots" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "market_research_snapshots_target_time_idx" ON "market_research_snapshots" USING btree ("target_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "market_targets_digest_uq" ON "market_targets" USING btree ("digest");