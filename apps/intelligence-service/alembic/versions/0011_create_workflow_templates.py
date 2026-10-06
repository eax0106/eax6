"""store Alter-authored starter workflow templates (D18)

Revision ID: 0011
Revises: 0010

Design log §19 requires the Capability Registry to hold reusable workflow
templates from day one, and those templates are authored by Alter, never
harvested from a customer's workflows. capability_registry_templates holds
them as versioned rows owned by the platform tenant; a CHECK makes any other
owner impossible, so no tenant's workflow can ever be stored here as a
template. Every row is readable by every tenant; writing needs the platform
tenant's context.

The first set (D18) is seeded from src/capability_registry/templates/v1. That
directory is frozen with this revision: a changed or added template is a new
directory and a new revision that supersedes the old rows, so this upgrade
always inserts exactly what was reviewed.
"""

import hashlib
import json
from collections.abc import Sequence
from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PLATFORM_TENANT_ID = "00000000-0000-7000-8000-000000000001"
_TEMPLATE_DIR = (
    Path(__file__).resolve().parents[2] / "src" / "capability_registry" / "templates" / "v1"
)
_PROVENANCE = {"source": "alter-authored", "set": "v1", "decision": "D18", "revision": "0011"}


def _set_platform_tenant() -> None:
    op.execute(
        sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)").bindparams(
            tenant=_PLATFORM_TENANT_ID
        )
    )


def upgrade() -> None:
    op.execute(
        sa.text(f"""
CREATE TABLE capability_registry_templates (
  template_id TEXT NOT NULL CHECK (template_id ~ '^[a-z][a-z0-9-]{{2,63}}$'),
  version INTEGER NOT NULL CHECK (version > 0),
  owner_tenant_id UUID NOT NULL DEFAULT '{_PLATFORM_TENANT_ID}'::uuid
    CHECK (owner_tenant_id = '{_PLATFORM_TENANT_ID}'::uuid),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 400),
  definition JSONB NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{{64}}$'),
  provenance JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
)
""")
    )
    op.execute(sa.text("ALTER TABLE capability_registry_templates ENABLE ROW LEVEL SECURITY"))
    op.execute(sa.text("ALTER TABLE capability_registry_templates FORCE ROW LEVEL SECURITY"))
    op.execute(
        sa.text("""
CREATE POLICY capability_registry_templates_visibility ON capability_registry_templates
USING (
  owner_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  OR owner_tenant_id = '00000000-0000-7000-8000-000000000001'::uuid
)
WITH CHECK (owner_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
""")
    )
    op.execute(
        sa.text(
            "CREATE UNIQUE INDEX idx_capability_registry_templates_one_active "
            "ON capability_registry_templates (template_id) WHERE status = 'active'"
        )
    )
    _set_platform_tenant()
    for path in sorted(_TEMPLATE_DIR.glob("*.json")):
        raw = path.read_bytes()
        definition = json.loads(raw)
        op.execute(
            sa.text("""
INSERT INTO capability_registry_templates
  (template_id, version, status, title, summary, definition, content_sha256, provenance)
VALUES (:template_id, 1, 'active', :title, :summary, CAST(:definition AS jsonb),
        :content_sha256, CAST(:provenance AS jsonb))
""").bindparams(
                template_id=definition["template_id"],
                title=definition["title"],
                summary=definition["summary"],
                definition=json.dumps(definition),
                content_sha256=hashlib.sha256(raw).hexdigest(),
                provenance=json.dumps(_PROVENANCE | {"file": path.name}),
            )
        )


def downgrade() -> None:
    op.execute(sa.text("DROP TABLE IF EXISTS capability_registry_templates"))
