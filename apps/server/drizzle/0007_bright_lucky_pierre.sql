CREATE TABLE "canonical_entities" (
	"game_data_version_id" uuid NOT NULL,
	"entity_kind" text NOT NULL,
	"canonical_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	CONSTRAINT "canonical_entities_game_data_version_id_entity_kind_canonical_id_pk" PRIMARY KEY("game_data_version_id","entity_kind","canonical_id")
);
--> statement-breakpoint
CREATE TABLE "game_data_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game" text NOT NULL,
	"patch_version" text NOT NULL,
	"source" text NOT NULL,
	"source_revision" text NOT NULL,
	"status" text DEFAULT 'importing' NOT NULL,
	"manifest_hash" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "game_data_versions_status_check" CHECK ("game_data_versions"."status" in ('importing', 'active', 'failed', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "canonical_entities" ADD CONSTRAINT "canonical_entities_game_data_version_id_game_data_versions_id_fk" FOREIGN KEY ("game_data_version_id") REFERENCES "public"."game_data_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canonical_entities_lookup_idx" ON "canonical_entities" USING btree ("game_data_version_id","entity_kind","canonical_id");--> statement-breakpoint
CREATE UNIQUE INDEX "game_data_versions_active_game_uq" ON "game_data_versions" USING btree ("game") WHERE "game_data_versions"."status" = 'active';