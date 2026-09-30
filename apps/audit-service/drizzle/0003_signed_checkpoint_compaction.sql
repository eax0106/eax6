DELETE FROM "audit_chain_checkpoints";
--> statement-breakpoint
ALTER TABLE "audit_chain_checkpoints"
  ADD COLUMN "signature" bytea NOT NULL,
  ADD COLUMN "signature_key_id" text NOT NULL,
  ADD CONSTRAINT "audit_chain_checkpoints_signature_length_check" CHECK (octet_length("signature") = 32),
  ADD CONSTRAINT "audit_chain_checkpoints_signature_key_id_check" CHECK (length(btrim("signature_key_id")) > 0);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.audit_retention_compaction', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is immutable'
    USING ERRCODE = '55000';
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION compact_audit_events_before_checkpoint(sealed_entry_hash bytea)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  deleted_rows integer;
BEGIN
  IF octet_length(sealed_entry_hash) <> 32 THEN
    RAISE EXCEPTION 'sealed checkpoint hash must be 32 bytes'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_events WHERE entry_hash = sealed_entry_hash) THEN
    RAISE EXCEPTION 'sealed checkpoint hash is not present in audit_events'
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.audit_retention_compaction', 'on', true);

  WITH RECURSIVE sealed_chain AS (
    SELECT id, entry_hash
    FROM audit_events AS root_event
    WHERE NOT EXISTS (
      SELECT 1
      FROM audit_events AS previous_event
      WHERE previous_event.entry_hash = root_event.prev_hash
    )
    UNION ALL
    SELECT next_event.id, next_event.entry_hash
    FROM audit_events AS next_event
    JOIN sealed_chain ON next_event.prev_hash = sealed_chain.entry_hash
    WHERE sealed_chain.entry_hash <> sealed_entry_hash
  ),
  deleted AS (
    DELETE FROM audit_events
    WHERE id IN (
      SELECT id
      FROM sealed_chain
      WHERE entry_hash <> sealed_entry_hash
    )
    RETURNING id
  )
  SELECT count(*)::integer INTO deleted_rows FROM deleted;

  RETURN deleted_rows;
END;
$function$;
