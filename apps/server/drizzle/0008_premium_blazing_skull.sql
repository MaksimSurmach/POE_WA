CREATE TABLE "provider_mappings" (
	"game_data_version_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"entity_kind" text NOT NULL,
	"canonical_id" text NOT NULL,
	"external_id" text NOT NULL,
	"discriminator" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"confidence" integer DEFAULT 100 NOT NULL,
	"source_revision" text NOT NULL,
	CONSTRAINT "provider_mappings_game_data_version_id_provider_entity_kind_canonical_id_external_id_pk" PRIMARY KEY("game_data_version_id","provider","entity_kind","canonical_id","external_id"),
	CONSTRAINT "provider_mappings_status_check" CHECK ("provider_mappings"."status" in ('active', 'disabled')),
	CONSTRAINT "provider_mappings_confidence_check" CHECK ("provider_mappings"."confidence" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "provider_mappings" ADD CONSTRAINT "provider_mappings_game_data_version_id_game_data_versions_id_fk" FOREIGN KEY ("game_data_version_id") REFERENCES "public"."game_data_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_mappings_resolve_idx" ON "provider_mappings" USING btree ("game_data_version_id","provider","entity_kind","canonical_id");