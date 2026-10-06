ALTER TABLE "oauth_states" ADD COLUMN IF NOT EXISTS "connection_id" uuid;
