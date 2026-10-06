"""register knowledge.search and whatsapp.send as global capabilities

Revision ID: 0010
Revises: 0009

Two tools were added to the canonical set (packages/contracts/src/tool-names.ts):
knowledge.search reads the run workspace's documents and has no side effects;
whatsapp.send sends from the workspace's connected WhatsApp account and does,
so synthesis holds it for approval. Same shape and idempotence as 0008: a tool
that already has an active global record is left alone, and downgrade removes
only the version-1 records this revision inserted.
"""

import json
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PLATFORM_TENANT_ID = "00000000-0000-7000-8000-000000000001"
_PROVENANCE = {"source": "canonical-tool-catalog", "revision": "0010"}
_TOOLS: tuple[tuple[str, bool], ...] = (
    ("knowledge.search", False),
    ("whatsapp.send", True),
)


def upgrade() -> None:
    # Global rows are owned by the platform tenant; the policy's WITH CHECK
    # admits only rows owned by the current tenant.
    op.execute(
        sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)").bindparams(
            tenant=_PLATFORM_TENANT_ID
        )
    )
    for name, side_effects in _TOOLS:
        capability_id = f"tool.{name}"
        op.execute(
            sa.text(
                """
INSERT INTO capability_registry_versions
  (capability_id, version, owner_tenant_id, scope, workspace_id, kind,
   supported_capabilities, side_effects, constraints, availability, provenance,
   metadata, status)
SELECT :capability_id, 1, CAST(:owner AS uuid), 'global', NULL, 'tool',
       CAST(:capabilities AS jsonb), :side_effects, '{}'::jsonb,
       '{"available": true}'::jsonb, CAST(:provenance AS jsonb), '{}'::jsonb, 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM capability_registry_versions
  WHERE owner_tenant_id = CAST(:owner AS uuid) AND capability_id = :capability_id
)
"""
            ).bindparams(
                capability_id=capability_id,
                owner=_PLATFORM_TENANT_ID,
                capabilities=json.dumps([capability_id]),
                side_effects=side_effects,
                provenance=json.dumps(_PROVENANCE),
            )
        )


def downgrade() -> None:
    op.execute(
        sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)").bindparams(
            tenant=_PLATFORM_TENANT_ID
        )
    )
    op.execute(
        sa.text(
            """
DELETE FROM capability_registry_versions
WHERE owner_tenant_id = CAST(:owner AS uuid)
  AND version = 1
  AND provenance ->> 'source' = 'canonical-tool-catalog'
  AND provenance ->> 'revision' = '0010'
"""
        ).bindparams(owner=_PLATFORM_TENANT_ID)
    )
