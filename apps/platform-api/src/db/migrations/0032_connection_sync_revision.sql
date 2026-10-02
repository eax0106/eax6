ALTER TABLE "oauth_connections" ADD COLUMN "source_revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_source_revision_check" CHECK ("source_revision" > 0);
--> statement-breakpoint
-- The authenticated sweep records its service principal, not a fabricated user UUID.
ALTER TABLE "oauth_connection_use_audits" ALTER COLUMN "used_by" TYPE text USING "used_by"::text;
