CREATE TABLE "rate_limit_endpoint_policies" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"policy" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_states" (
	"policy" text PRIMARY KEY NOT NULL,
	"blocked_until" timestamp with time zone DEFAULT now() NOT NULL,
	"next_request_at" timestamp with time zone DEFAULT now() NOT NULL,
	"minimum_delay_ms" integer DEFAULT 1000 NOT NULL,
	"windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_status" integer,
	"last_response_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_states_minimum_delay_check" CHECK ("rate_limit_states"."minimum_delay_ms" > 0),
	CONSTRAINT "rate_limit_states_last_status_check" CHECK ("rate_limit_states"."last_status" is null or "rate_limit_states"."last_status" between 100 and 599)
);
--> statement-breakpoint
ALTER TABLE "rate_limit_endpoint_policies" ADD CONSTRAINT "rate_limit_endpoint_policies_policy_rate_limit_states_policy_fk" FOREIGN KEY ("policy") REFERENCES "public"."rate_limit_states"("policy") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "rate_limit_endpoint_policies_policy_idx" ON "rate_limit_endpoint_policies" USING btree ("policy");--> statement-breakpoint
CREATE INDEX "rate_limit_states_blocked_until_idx" ON "rate_limit_states" USING btree ("blocked_until");
