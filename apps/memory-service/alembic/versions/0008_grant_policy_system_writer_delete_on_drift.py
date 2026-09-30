"""let policy_system_writer delete a tenant's drift scores (tenant erasure, D2)

Revision ID: 0008
Revises: 0007
Create Date: 2026-09-30

Agent drift scores are writable only by `policy_system_writer` (row security,
0001), so erasing a tenant's drift scores is that role's job. It gets DELETE
on drift_scores and nothing else: memory records, policies and promotions are
erased in the tenant's own session under its own row security.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ROLE = "policy_system_writer"


def _when_role_exists(statement: str) -> str:
    return f"""
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{_ROLE}') THEN
    EXECUTE '{statement}';
  END IF;
END $$;
"""


def upgrade() -> None:
    op.execute(sa.text(_when_role_exists(f"GRANT DELETE ON drift_scores TO {_ROLE}")))


def downgrade() -> None:
    op.execute(sa.text(_when_role_exists(f"REVOKE DELETE ON drift_scores FROM {_ROLE}")))
