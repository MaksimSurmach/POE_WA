SET LOCAL lock_timeout = '3s';--> statement-breakpoint
CREATE TABLE "scraped_item_recipes" (
	"recipe_id" text NOT NULL,
	"role" text NOT NULL,
	"item_id" uuid NOT NULL,
	"authored_digest" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scraped_item_recipes_recipe_id_role_pk" PRIMARY KEY("recipe_id","role")
);
--> statement-breakpoint
CREATE TABLE "scraped_item_revisions" (
	"item_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"cause" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scraped_item_revisions_item_id_revision_pk" PRIMARY KEY("item_id","revision"),
	CONSTRAINT "scraped_item_revisions_cause_check" CHECK ("scraped_item_revisions"."cause" in ('seed', 'edit', 'link', 'unlink'))
);
--> statement-breakpoint
CREATE TABLE "scraped_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" text NOT NULL,
	"spec" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"origin" text DEFAULT 'recipe' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scraped_items_role_check" CHECK ("scraped_items"."role" in ('base', 'output')),
	CONSTRAINT "scraped_items_origin_check" CHECK ("scraped_items"."origin" in ('recipe', 'owner')),
	CONSTRAINT "scraped_items_revision_check" CHECK ("scraped_items"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "run_requests" DROP CONSTRAINT "run_requests_scope_recipe_check";--> statement-breakpoint
DROP INDEX "run_requests_active_scope_recipe_uq";--> statement-breakpoint
ALTER TABLE "run_requests" ADD COLUMN "scraped_item_id" uuid;--> statement-breakpoint
ALTER TABLE "run_requests" ADD COLUMN "scraped_item_revision" integer;--> statement-breakpoint
ALTER TABLE "run_requests" ADD COLUMN "schedule_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "scraped_items_id_role_uq" ON "scraped_items" USING btree ("id","role");--> statement-breakpoint
ALTER TABLE "scraped_item_recipes" ADD CONSTRAINT "scraped_item_recipes_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scraped_item_recipes" ADD CONSTRAINT "scraped_item_recipes_item_role_fk" FOREIGN KEY ("item_id","role") REFERENCES "public"."scraped_items"("id","role") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scraped_item_revisions" ADD CONSTRAINT "scraped_item_revisions_item_id_scraped_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."scraped_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scraped_item_recipes_item_idx" ON "scraped_item_recipes" USING btree ("item_id");--> statement-breakpoint
ALTER TABLE "run_requests" ADD CONSTRAINT "run_requests_scraped_item_id_scraped_items_id_fk" FOREIGN KEY ("scraped_item_id") REFERENCES "public"."scraped_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_requests_active_scope_recipe_uq" ON "run_requests" USING btree ("scope",coalesce("recipe_id", ''),coalesce("scraped_item_id"::text || ':' || "scraped_item_revision"::text, '')) WHERE "run_requests"."state" in ('queued', 'running');--> statement-breakpoint
ALTER TABLE "run_requests" ADD CONSTRAINT "run_requests_scope_recipe_check" CHECK (("run_requests"."scope" = 'all' and "run_requests"."recipe_id" is null and "run_requests"."scraped_item_id" is null)
        or ("run_requests"."scope" = 'recipe' and "run_requests"."recipe_id" is not null and "run_requests"."scraped_item_id" is null)
        or ("run_requests"."scope" = 'item' and "run_requests"."recipe_id" is null and "run_requests"."scraped_item_id" is not null
          and "run_requests"."scraped_item_revision" is not null and "run_requests"."schedule_key" is not null));