ALTER TABLE "refresh_cycles" DROP CONSTRAINT "refresh_cycles_status_check";--> statement-breakpoint
ALTER TABLE "refresh_cycles" ADD CONSTRAINT "refresh_cycles_status_check" CHECK ("status" in ('queued', 'running', 'completed', 'published', 'failed', 'superseded'));
