CREATE TABLE "provider_circuits" (
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"status" text DEFAULT 'closed' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"probe_lease_until" timestamp with time zone,
	"last_failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_circuits_provider_endpoint_pk" PRIMARY KEY("provider","endpoint"),
	CONSTRAINT "provider_circuits_status_check" CHECK ("provider_circuits"."status" in ('closed', 'open', 'half_open')),
	CONSTRAINT "provider_circuits_failures_check" CHECK ("provider_circuits"."consecutive_failures" >= 0)
);
--> statement-breakpoint
CREATE INDEX "provider_circuits_status_retry_at_idx" ON "provider_circuits" USING btree ("status","retry_at");