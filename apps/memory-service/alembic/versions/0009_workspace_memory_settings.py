# ruff: noqa: E501
"""Workspace memory settings, local memory attribution and retention.

Revision ID: 0009
Revises: 0008
"""

import sqlalchemy as sa

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        sa.text("""
CREATE TABLE workspace_memory_settings (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL,
 chat_enabled boolean NOT NULL DEFAULT true,
 workflow_enabled boolean NOT NULL DEFAULT true,
 workspace_enabled boolean NOT NULL DEFAULT true,
 retention_days integer NOT NULL DEFAULT 90 CHECK(retention_days BETWEEN 7 AND 365),
 version integer NOT NULL DEFAULT 0 CHECK(version >= 0),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,workspace_id)
);
CREATE TABLE memory_settings_audit (
 id text PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL,
 actor_ref text NOT NULL, before_value jsonb NOT NULL, after_value jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_settings_audit_workspace ON memory_settings_audit(tenant_id,workspace_id,created_at);
ALTER TABLE workspace_memory_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_memory_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_settings_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_settings_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_settings_tenant ON workspace_memory_settings FOR ALL
 USING (tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid);
CREATE POLICY memory_settings_audit_tenant ON memory_settings_audit FOR ALL
 USING (tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid);
CREATE FUNCTION reject_memory_settings_scope_change() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
   OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
   RAISE EXCEPTION 'Memory settings scope is immutable';
  END IF;
  RETURN NEW;
 END $$;
CREATE TRIGGER memory_settings_scope_immutable BEFORE UPDATE ON workspace_memory_settings
 FOR EACH ROW EXECUTE FUNCTION reject_memory_settings_scope_change();
CREATE TRIGGER memory_settings_audit_scope_immutable BEFORE UPDATE ON memory_settings_audit
 FOR EACH ROW EXECUTE FUNCTION reject_memory_settings_scope_change();
ALTER TABLE memory_records ADD COLUMN workspace_id uuid;
ALTER TABLE memory_records ADD COLUMN memory_kind text CHECK(memory_kind IN ('chat','workflow','workspace'));
ALTER TABLE memory_records ADD COLUMN context_id text;
UPDATE memory_records SET workspace_id=substring(provenance->>'workspace_id' FROM 4)::uuid,
 memory_kind='workflow' WHERE tenant_id IS NOT NULL AND scope<>'global'
 AND provenance->>'workspace_id' ~ '^ws_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
ALTER TABLE memory_records ADD CONSTRAINT memory_global_no_local_attribution CHECK(
 tenant_id IS NOT NULL OR (workspace_id IS NULL AND memory_kind IS NULL AND context_id IS NULL)
);
CREATE INDEX memory_records_workspace_kind ON memory_records(tenant_id,workspace_id,memory_kind,created_at DESC);
CREATE UNIQUE INDEX memory_chat_context_unique ON memory_records(tenant_id,workspace_id,context_id)
 WHERE memory_kind='chat';
CREATE TABLE memory_retention_tenants(tenant_id uuid PRIMARY KEY);
ALTER TABLE memory_records NO FORCE ROW LEVEL SECURITY;
INSERT INTO memory_retention_tenants(tenant_id)
 SELECT DISTINCT tenant_id FROM memory_records WHERE tenant_id IS NOT NULL;
ALTER TABLE memory_records FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_retention_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_retention_tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_retention_tenant ON memory_retention_tenants FOR ALL
 USING (tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid);
CREATE POLICY memory_retention_subjects ON memory_retention_tenants FOR SELECT
 USING(current_user='policy_system_writer');
CREATE FUNCTION register_memory_retention_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF NEW.tenant_id IS NOT NULL THEN
   INSERT INTO memory_retention_tenants(tenant_id) VALUES(NEW.tenant_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
 END $$;
CREATE TRIGGER memory_retention_register AFTER INSERT ON memory_records
 FOR EACH ROW EXECUTE FUNCTION register_memory_retention_tenant();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='policy_system_writer') THEN
  GRANT SELECT ON memory_retention_tenants TO policy_system_writer;
 END IF;
END $$;
""")
    )


def downgrade() -> None:
    op.execute(
        sa.text("""
DROP TRIGGER memory_retention_register ON memory_records;
DROP FUNCTION register_memory_retention_tenant();
DROP TABLE memory_retention_tenants;
DROP INDEX IF EXISTS memory_chat_context_unique;
DROP INDEX IF EXISTS memory_records_workspace_kind;
ALTER TABLE memory_records DROP CONSTRAINT memory_global_no_local_attribution;
ALTER TABLE memory_records DROP COLUMN context_id;
ALTER TABLE memory_records DROP COLUMN memory_kind;
ALTER TABLE memory_records DROP COLUMN workspace_id;
DROP TABLE memory_settings_audit;
DROP TABLE workspace_memory_settings;
DROP FUNCTION reject_memory_settings_scope_change();
""")
    )
