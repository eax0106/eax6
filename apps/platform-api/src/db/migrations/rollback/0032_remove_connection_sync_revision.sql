-- Refuse to discard service attribution if the old UUID schema cannot represent it.
ALTER TABLE "oauth_connection_use_audits" ALTER COLUMN "used_by" TYPE uuid USING "used_by"::uuid;
--> statement-breakpoint
ALTER TABLE "oauth_connections" DROP COLUMN "source_revision";
