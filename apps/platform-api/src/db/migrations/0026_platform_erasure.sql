-- Retention and erasure for platform_db (D2, task C3b).
--
-- 1. tenants.deleted_at: when a tenant's data was erased. The tenant row stays as
--    a tombstone (id and deleted_at, every other field cleared) because the staff
--    access logs kept for 90 days after erasure point at it (D2); the retention
--    sweeper destroys the tombstone with them.
-- 2. legal_hold_records: what the law says must outlive a tenant (tax invoices
--    and billing, books of account, seller KYC and payouts), reduced to the
--    minimum fields, with the date it must be destroyed. It names the tenant
--    only by pseudonym; there is no tenant column and no foreign key, so erasing
--    a tenant never reaches it and the tombstone need not outlive 90 days.
-- 3. tenant_erasure_manifests: one row per erasure run, with the secrets it
--    still has to delete from the secrets store.
-- 4. Erasing append-only rows. action_item_annotations stays append-only for
--    every session except one running as the dedicated role platform_erasure
--    (only its SECURITY DEFINER function runs as it) and only while an active
--    manifest names the row's tenant. A normal application session, whatever
--    tenant it has set, cannot delete a row. The same for payout_ledger is
--    marketplace migration 0006.
--
-- Rollback: restore prevent_action_item_annotation_mutation() from migration
--   0014 (it raises unconditionally), then
--   DROP FUNCTION erase_tenant_action_annotations(uuid, text), pseudonymise_orphan_users(uuid[]),
--     list_platform_tenant_ids();
--   DROP TABLE tenant_erasure_manifests, legal_hold_records;
--   ALTER TABLE tenants DROP COLUMN deleted_at;
--   DROP OWNED BY platform_erasure; DROP ROLE platform_erasure;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_hold_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_pseudonym" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('tax_invoice', 'books_of_account', 'seller_kyc', 'seller_payout')),
  "source_table" text NOT NULL,
  "source_id" text NOT NULL,
  "minimal" jsonb NOT NULL,
  "held_at" timestamptz NOT NULL DEFAULT now(),
  "retain_until" timestamptz NOT NULL,
  CONSTRAINT "legal_hold_records_source_unique" UNIQUE ("source_table", "source_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_hold_records_retain_until_idx" ON "legal_hold_records" ("retain_until");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_erasure_manifests" (
  "manifest_id" text PRIMARY KEY CHECK ("manifest_id" ~ '^del_[0-9a-f-]{36}$'),
  "tenant_id" uuid NOT NULL,
  "state" text NOT NULL DEFAULT 'active' CHECK ("state" IN ('active', 'secrets_pending', 'complete')),
  "secret_refs" text[] NOT NULL DEFAULT '{}',
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_erasure_manifests_tenant_idx" ON "tenant_erasure_manifests" ("tenant_id");
--> statement-breakpoint
DO $role$
BEGIN
  BEGIN
    CREATE ROLE platform_erasure NOLOGIN NOSUPERUSER NOBYPASSRLS;
  EXCEPTION WHEN duplicate_object THEN
    NULL; -- also covers two migrations creating it at the same moment
  END;
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO platform_erasure', current_schema());
END
$role$;
--> statement-breakpoint
GRANT SELECT ON "tenant_erasure_manifests" TO platform_erasure;
--> statement-breakpoint
GRANT SELECT, DELETE ON "action_item_annotations" TO platform_erasure;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_action_item_annotation_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_user = 'platform_erasure'
     AND EXISTS (
       SELECT 1 FROM tenant_erasure_manifests m
        WHERE m.tenant_id = OLD.tenant_id AND m.state = 'active'
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'action_item_annotations is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $fn$
BEGIN
  -- Pinned to the schema the tables live in, so the definer function cannot be
  -- steered by the caller's search_path.
  EXECUTE format($def$
    CREATE OR REPLACE FUNCTION erase_tenant_action_annotations(p_tenant uuid, p_manifest text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $body$
    DECLARE
      removed integer;
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM tenant_erasure_manifests
         WHERE manifest_id = p_manifest AND tenant_id = p_tenant AND state = 'active'
      ) THEN
        RAISE EXCEPTION 'no active erasure manifest for this tenant';
      END IF;
      PERFORM set_config('app.current_tenant_id', p_tenant::text, true);
      DELETE FROM action_item_annotations WHERE tenant_id = p_tenant;
      GET DIAGNOSTICS removed = ROW_COUNT;
      RETURN removed;
    END;
    $body$
  $def$, current_schema());
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION erase_tenant_action_annotations(uuid, text) OWNER TO platform_erasure;
--> statement-breakpoint
REVOKE ALL ON FUNCTION erase_tenant_action_annotations(uuid, text) FROM PUBLIC;
--> statement-breakpoint
-- Erasing a tenant must not leave its members' identities behind, but a user can
-- belong to several tenants and tenant_members is row-secured, so the check
-- "no membership anywhere" cannot be made from inside one tenant's session.
-- These two definer functions (owned by the migration identity, like the other
-- cross-tenant functions) do exactly that and nothing else.
DO $fn$
BEGIN
  EXECUTE format($def$
    CREATE OR REPLACE FUNCTION pseudonymise_orphan_users(p_user_ids uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %1$I, pg_temp AS $body$
    DECLARE
      changed integer;
    BEGIN
      UPDATE users u
         SET email = 'erased-' || u.id || '@erased.invalid',
             display_name = NULL,
             identity_ref = 'erased:' || u.id,
             status = 'suspended',
             preferred_language = 'en',
             updated_at = now()
       WHERE u.id = ANY (p_user_ids)
         AND NOT EXISTS (SELECT 1 FROM tenant_members m WHERE m.user_id = u.id);
      GET DIAGNOSTICS changed = ROW_COUNT;
      RETURN changed;
    END;
    $body$
  $def$, current_schema());
  EXECUTE format($def$
    CREATE OR REPLACE FUNCTION list_platform_tenant_ids() RETURNS SETOF uuid
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = %1$I, pg_temp AS $body$
      SELECT id FROM tenants ORDER BY id
    $body$
  $def$, current_schema());
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pseudonymise_orphan_users(uuid[]) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION list_platform_tenant_ids() FROM PUBLIC;
