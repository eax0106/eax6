"""supersede knowledge-qa with an unambiguous run-level criterion (v4)

Revision ID: 0014
Revises: 0013

templates/v4 is the next reviewed set: the same eight files, one of them
changed. The end-of-run review judges each success criterion on its own and
fails the run on any one it marks unmet, including a conditional criterion
whose condition does not hold. knowledge-qa's v3 criteria split the two
outcomes ("A supported answer..." and "When no passage or attached text
supports an answer..."): a live local run (run_c582a4c5) answered correctly
from the attached text after an empty search and failed on the second, and a
correct "documents do not answer" outcome failed on the first in 5 of 5
measured trials. One criterion now states both outcomes as meeting it.

For each v4 file that differs from its v3 file, the active row is marked
superseded and the v4 file is inserted as the next version, active. Unchanged
files keep their row. templates/v4 is frozen with this revision.
"""

import hashlib
import json
from collections.abc import Sequence
from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PLATFORM_TENANT_ID = "00000000-0000-7000-8000-000000000001"
_TEMPLATES = Path(__file__).resolve().parents[2] / "src" / "capability_registry" / "templates"
_PREVIOUS_DIR = _TEMPLATES / "v3"
_TEMPLATE_DIR = _TEMPLATES / "v4"
_PROVENANCE = {"source": "alter-authored", "set": "v4", "decision": "D18", "revision": "0014"}


def changed_files() -> list[Path]:
    """The v4 files whose bytes differ from the v3 file of the same name."""
    return [
        path
        for path in sorted(_TEMPLATE_DIR.glob("*.json"))
        if path.read_bytes() != (_PREVIOUS_DIR / path.name).read_bytes()
    ]


def _set_platform_tenant() -> None:
    op.execute(
        sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)").bindparams(
            tenant=_PLATFORM_TENANT_ID
        )
    )


def upgrade() -> None:
    _set_platform_tenant()
    for path in changed_files():
        raw = path.read_bytes()
        definition = json.loads(raw)
        template_id = definition["template_id"]
        op.execute(
            sa.text(
                "UPDATE capability_registry_templates SET status = 'superseded' "
                "WHERE template_id = :template_id AND status = 'active'"
            ).bindparams(template_id=template_id)
        )
        op.execute(
            sa.text("""
INSERT INTO capability_registry_templates
  (template_id, version, status, title, summary, definition, content_sha256, provenance)
SELECT :template_id, COALESCE(max(version), 0) + 1, 'active', :title, :summary,
       CAST(:definition AS jsonb), :content_sha256, CAST(:provenance AS jsonb)
FROM capability_registry_templates WHERE template_id = :template_id
""").bindparams(
                template_id=template_id,
                title=definition["title"],
                summary=definition["summary"],
                definition=json.dumps(definition),
                content_sha256=hashlib.sha256(raw).hexdigest(),
                provenance=json.dumps(_PROVENANCE | {"file": path.name}),
            )
        )


def downgrade() -> None:
    _set_platform_tenant()
    for path in changed_files():
        template_id = json.loads(path.read_bytes())["template_id"]
        op.execute(
            sa.text(
                "DELETE FROM capability_registry_templates "
                "WHERE template_id = :template_id AND provenance->>'revision' = '0014'"
            ).bindparams(template_id=template_id)
        )
        op.execute(
            sa.text(
                "UPDATE capability_registry_templates SET status = 'active' "
                "WHERE template_id = :template_id AND version = ("
                "SELECT max(version) FROM capability_registry_templates "
                "WHERE template_id = :template_id)"
            ).bindparams(template_id=template_id)
        )
