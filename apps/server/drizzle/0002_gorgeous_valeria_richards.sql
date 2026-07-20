ALTER TABLE "refresh_cycles" DROP CONSTRAINT "refresh_cycles_counts_check";--> statement-breakpoint
ALTER TABLE "refresh_cycles" ADD COLUMN "total_queries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_cycles" ADD CONSTRAINT "refresh_cycles_counts_check" CHECK ("refresh_cycles"."total_recipes" >= 0 and "refresh_cycles"."total_queries" >= 0 and "refresh_cycles"."completed_recipes" >= 0 and "refresh_cycles"."failed_recipes" >= 0 and "refresh_cycles"."completed_recipes" + "refresh_cycles"."failed_recipes" <= "refresh_cycles"."total_recipes");
