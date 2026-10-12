"""supersede three starter templates whose search step judged relevance (v2)

Revision ID: 0012
Revises: 0011

Revision 0011 froze templates/v1. templates/v2 is the next reviewed set: the
same eight files, three of them changed. In knowledge-qa, brand-mention-alert
and whatsapp-faq-responder the search step had no success criteria of its own,
so the Verify Gate reviewed its raw results against the run's purpose and
failed a real result set for containing a namesake or an unanswering passage,
the very items the next model step exists to drop (live run_69ef088e: the
brand search failed three times on a namesake company). v2 gives each search
step criteria that state its own job.

For each v2 file that differs from its v1 file, the active row is marked
superseded and the v2 file is inserted as the next version, active. Unchanged
files keep their v1 row. templates/v2 is frozen with this revision.
"""

import hashlib
import json
from collections.abc import Sequence
from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PLATFORM_TENANT_ID = "00000000-0000-7000-8000-000000000001"
_TEMPLATES = Path(__file__).resolve().parents[2] / "src" / "capability_registry" / "templates"
_PREVIOUS_DIR = _TEMPLATES / "v1"
_TEMPLATE_DIR = _TEMPLATES / "v2"
_PROVENANCE = {"source": "alter-authored", "set": "v2", "decision": "D18", "revision": "0012"}


def changed_files() -> list[Path]:
    """The v2 files whose bytes differ from the v1 file of the same name."""
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
                "WHERE template_id = :template_id AND provenance->>'revision' = '0012'"
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
