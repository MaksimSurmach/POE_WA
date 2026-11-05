CREATE SCHEMA "market_collector_private";
--> statement-breakpoint
CREATE TABLE "market_collector_private"."trade_session" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"sealed_session" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_session_singleton_check" CHECK ("market_collector_private"."trade_session"."singleton")
);
