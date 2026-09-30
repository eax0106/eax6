DROP FUNCTION IF EXISTS compact_audit_events_before_checkpoint(bytea);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'audit_events is immutable'
    USING ERRCODE = '55000';
END;
$function$;
--> statement-breakpoint
ALTER TABLE "audit_chain_checkpoints"
  DROP CONSTRAINT IF EXISTS "audit_chain_checkpoints_signature_key_id_check",
  DROP CONSTRAINT IF EXISTS "audit_chain_checkpoints_signature_length_check",
  DROP COLUMN IF EXISTS "signature_key_id",
  DROP COLUMN IF EXISTS "signature";
