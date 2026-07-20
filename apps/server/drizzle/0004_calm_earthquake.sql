ALTER TABLE "recipe_evaluations" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "recipe_evaluations" ADD COLUMN "last_successful_at" timestamp with time zone;
