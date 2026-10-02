"""Add the narrow agent ownership lookup for service assertions."""

import sqlalchemy as sa

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        sa.text("""
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intelligence_service') THEN
    CREATE ROLE intelligence_service NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT SELECT (id, tenant_id) ON agents TO intelligence_drift_reader;
CREATE FUNCTION agent_owner_tenant(p_agent_id text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT tenant_id FROM public.agents WHERE id = p_agent_id $$;
ALTER FUNCTION agent_owner_tenant(text) OWNER TO intelligence_drift_reader;
REVOKE ALL ON FUNCTION agent_owner_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_owner_tenant(text) TO intelligence_service;
""")
    )


def downgrade() -> None:
    op.execute(
        sa.text("""
DROP FUNCTION agent_owner_tenant(text);
REVOKE SELECT (id, tenant_id) ON agents FROM intelligence_drift_reader;
""")
    )
