-- D2/Y2 signed closed-prefix compaction. Provision audit_retention separately
-- as a restricted login before migration; it receives no table privileges.
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS erased_at timestamptz;
--> statement-breakpoint
ALTER TABLE audit_events ALTER COLUMN actor_ref DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE audit_events DROP CONSTRAINT audit_events_support_reason_check;
--> statement-breakpoint
ALTER TABLE audit_events ADD CONSTRAINT audit_events_support_reason_check CHECK (
  (erased_at IS NOT NULL AND actor_ref IS NULL AND reason_code IS NULL AND context IS NULL)
  OR NOT (actor_type = 'support' OR lower(action) LIKE 'support.access%'
    OR position('break_glass' IN lower(action)) > 0 OR position('break-glass' IN lower(action)) > 0)
  OR nullif(btrim(reason_code), '') IS NOT NULL
);
--> statement-breakpoint
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS chain_position bigint;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_events_immutable ON audit_events;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS audit_chain_position_seq;
--> statement-breakpoint
-- Hash-link order, never event time or physical row order. Refuse a
-- disconnected historical chain instead of assigning it trusted positions.
DO $backfill$
DECLARE total bigint; linked bigint;
BEGIN
  PERFORM set_config('app.audit_internal', 'on', true);
  IF EXISTS (SELECT 1 FROM audit_events WHERE chain_position IS NULL) THEN
    SELECT count(*) INTO total FROM audit_events;
    WITH RECURSIVE chain AS (
      SELECT id, entry_hash, 1::bigint AS position FROM audit_events
      WHERE prev_hash = decode(repeat('00', 32), 'hex')
      UNION ALL
      SELECT e.id, e.entry_hash, c.position + 1 FROM audit_events e
      JOIN chain c ON e.prev_hash = c.entry_hash WHERE c.position < total
    ) UPDATE audit_events e SET chain_position = c.position FROM chain c WHERE e.id = c.id;
    GET DIAGNOSTICS linked = ROW_COUNT;
    IF linked <> total THEN RAISE EXCEPTION 'Audit chain backfill refused'; END IF;
  END IF;
  PERFORM setval('audit_chain_position_seq', COALESCE((SELECT max(chain_position) FROM audit_events), 1),
    EXISTS (SELECT 1 FROM audit_events));
END;
$backfill$;
--> statement-breakpoint
ALTER TABLE audit_events ALTER COLUMN chain_position SET NOT NULL;
--> statement-breakpoint
ALTER TABLE audit_events ALTER COLUMN chain_position SET DEFAULT nextval('audit_chain_position_seq');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_chain_position_unique ON audit_events(chain_position);
--> statement-breakpoint
ALTER TABLE audit_chain_checkpoints ADD COLUMN IF NOT EXISTS signature bytea;
--> statement-breakpoint
ALTER TABLE audit_chain_checkpoints ADD COLUMN IF NOT EXISTS last_position bigint;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_event_mutation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cut bigint;
BEGIN
  IF session_user <> 'audit_retention' OR current_user <> 'audit_service' THEN
    RAISE EXCEPTION 'audit_events is immutable' USING ERRCODE = '55000';
  END IF;
  SELECT last_position INTO cut FROM audit_chain_checkpoints
    WHERE id = 'global' AND octet_length(signature) = 32;
  IF cut IS NULL OR OLD.chain_position > cut THEN RAISE EXCEPTION 'Audit event is not sealed' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.erased_at IS NULL
    AND NEW.tenant_id IS NULL AND NEW.tenant_pseudonym IS NOT NULL
    AND NEW.actor_ref IS NULL AND NEW.target_ref IS NULL
    AND NEW.context IS NULL AND NEW.reason_code IS NULL
    AND NEW.erased_at = transaction_timestamp()
    AND NEW.id = OLD.id AND NEW.chain_position = OLD.chain_position
    AND NEW.actor_type = OLD.actor_type AND NEW.action = OLD.action
    AND NEW.target_type IS NOT DISTINCT FROM OLD.target_type
    AND NEW.result = OLD.result AND NEW.occurred_at = OLD.occurred_at
    AND NEW.prev_hash = OLD.prev_hash AND NEW.entry_hash = OLD.entry_hash THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' AND OLD.chain_position <= cut AND OLD.tenant_id IS NULL
    AND OLD.tenant_pseudonym IS NOT NULL AND OLD.erased_at IS NOT NULL
    AND OLD.erased_at <= transaction_timestamp() - interval '90 days'
    AND EXISTS (SELECT 1 FROM deletion_ledger l WHERE l.subject_pseudonym = OLD.tenant_pseudonym
      AND l.deleted_at <= transaction_timestamp() - interval '90 days') THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Audit skeleton mutation refused' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION audit_event_mutation_guard();
--> statement-breakpoint
-- Definer uses the existing audit RLS identity. Session identity, not a
-- settable GUC or role membership, restricts this path to its separate login.
CREATE OR REPLACE FUNCTION minimise_audit_tenant(p_tenant uuid, p_pseudonym text, p_position bigint, p_anchor bytea)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cut bigint; n integer;
BEGIN
  IF session_user <> 'audit_retention' THEN RAISE EXCEPTION 'Audit retention identity required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('alter.audit.global-chain.v1', 0));
  PERFORM set_config('app.audit_internal', 'on', true);
  IF NOT EXISTS (SELECT 1 FROM audit_events WHERE tenant_id = p_tenant AND erased_at IS NULL) THEN RETURN 0; END IF;
  SELECT last_position INTO cut FROM audit_chain_checkpoints
    WHERE id = 'global' AND last_position = p_position AND last_entry_hash = p_anchor AND octet_length(signature) = 32;
  IF cut IS NULL OR nullif(p_pseudonym, '') IS NULL THEN RAISE EXCEPTION 'Signed audit prefix required'; END IF;
  IF EXISTS (SELECT 1 FROM audit_events WHERE tenant_id = p_tenant AND chain_position > cut) THEN
    RAISE EXCEPTION 'Audit tenant has unsealed events';
  END IF;
  UPDATE audit_events SET tenant_id = NULL, tenant_pseudonym = p_pseudonym,
    actor_ref = NULL, target_ref = NULL, reason_code = NULL, context = NULL,
    erased_at = transaction_timestamp()
    WHERE tenant_id = p_tenant AND erased_at IS NULL AND chain_position <= cut;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION expire_audit_skeletons(p_cutoff timestamptz, p_anchor bytea, p_position bigint)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cut bigint; n integer;
BEGIN
  IF session_user <> 'audit_retention' THEN RAISE EXCEPTION 'Audit retention identity required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('alter.audit.global-chain.v1', 0));
  PERFORM set_config('app.audit_internal', 'on', true);
  SELECT last_position INTO cut FROM audit_chain_checkpoints
    WHERE id = 'global' AND last_entry_hash = p_anchor AND last_position = p_position AND octet_length(signature) = 32;
  IF cut IS NULL THEN RAISE EXCEPTION 'Signed audit prefix required'; END IF;
  DELETE FROM audit_events e WHERE e.chain_position <= cut AND e.tenant_id IS NULL
    AND e.erased_at <= LEAST(p_cutoff, transaction_timestamp() - interval '90 days')
    AND EXISTS (SELECT 1 FROM deletion_ledger l WHERE l.subject_pseudonym = e.tenant_pseudonym
      AND l.deleted_at <= LEAST(p_cutoff, transaction_timestamp() - interval '90 days'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION minimise_audit_tenant(uuid, text, bigint, bytea), expire_audit_skeletons(timestamptz, bytea, bigint) FROM PUBLIC;
--> statement-breakpoint
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_retention') THEN
    GRANT USAGE ON SCHEMA public TO audit_retention;
    GRANT EXECUTE ON FUNCTION minimise_audit_tenant(uuid, text, bigint, bytea), expire_audit_skeletons(timestamptz, bytea, bigint) TO audit_retention;
  END IF;
END;
$grants$;
