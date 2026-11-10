SET LOCAL lock_timeout = '3s';--> statement-breakpoint
DROP TABLE "craft_allocation_plans" RESTRICT;--> statement-breakpoint
DROP TABLE "craft_probability_results" RESTRICT;--> statement-breakpoint
DROP TABLE "craft_signal_history" RESTRICT;--> statement-breakpoint
DROP TABLE "craft_signal_states" RESTRICT;--> statement-breakpoint
DROP TABLE "market_collection_checkpoints" RESTRICT;--> statement-breakpoint
DO $$
BEGIN
  IF to_regnamespace('pgboss') IS NOT NULL THEN
    IF to_regclass('pgboss.job') IS NOT NULL AND EXISTS (
      SELECT 1 FROM pgboss.job WHERE state::text IN ('created', 'retry', 'active')
    ) THEN
      RAISE EXCEPTION 'Legacy pg-boss still has pending or active work';
    END IF;
    ALTER SCHEMA pgboss RENAME TO worksmith_archive_pgboss;
  END IF;
END
$$;
