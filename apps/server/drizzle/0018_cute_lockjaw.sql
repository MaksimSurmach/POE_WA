CREATE TABLE "belt_price_updates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"data_kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "belt_price_updates_kind_check" CHECK ("belt_price_updates"."data_kind" in ('observed', 'demo')),
	CONSTRAINT "belt_price_updates_payload_object" CHECK (jsonb_typeof("belt_price_updates"."payload") = 'object')
);
--> statement-breakpoint
ALTER TABLE "belt_price_updates" ADD CONSTRAINT "belt_price_updates_target_id_market_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."market_targets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "belt_price_updates_digest_uq" ON "belt_price_updates" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "belt_price_updates_target_time_idx" ON "belt_price_updates" USING btree ("target_id","created_at");