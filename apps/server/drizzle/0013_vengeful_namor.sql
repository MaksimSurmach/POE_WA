CREATE TABLE "craft_probability_results" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"setup_hash" text NOT NULL,
	"game_data_version" text NOT NULL,
	"ruleset_id" text NOT NULL,
	"engine_id" text NOT NULL,
	"engine_version" text NOT NULL,
	"calculator_contract_version" integer NOT NULL,
	"probability_numerator" text NOT NULL,
	"probability_denominator" text NOT NULL,
	"expected_attempts_numerator" text NOT NULL,
	"expected_attempts_denominator" text NOT NULL,
	"probability_decimal" text NOT NULL,
	"expected_attempts_decimal" text NOT NULL,
	"diagnostics" jsonb NOT NULL,
	"calculated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
