-- Notification producers (D1 follow-up): a producer that reads the engine on a
-- schedule sees the same failure again on its next pass, so each notification
-- it creates carries a dedupe key and the database refuses a second one.
-- Nothing else reads the key. Nullable: every existing producer keeps working.
--
-- Rollback: DROP INDEX IF EXISTS notification_events_dedupe_key_unique;
--           ALTER TABLE notification_events DROP COLUMN IF EXISTS dedupe_key;
ALTER TABLE "notification_events" ADD COLUMN IF NOT EXISTS "dedupe_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_events_dedupe_key_unique"
ON "notification_events" ("tenant_id", "dedupe_key")
WHERE "dedupe_key" IS NOT NULL;
