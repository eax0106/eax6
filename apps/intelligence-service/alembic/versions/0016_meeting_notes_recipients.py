"""Meeting notes go to one recipient or a list (v6).

email.send accepts a list of addresses (#201), but the meeting-notes run
criterion still asked for "one summary email" to "the stated recipient", so
the end-of-run review failed a run whose send to five listed addresses had
succeeded (run_addffb10). The criterion now asks for the summary to reach
every address in the intake's recipient, whether one address or a list, and a
list test case is added. The send step is unchanged: it already passes the
recipient through. Frozen v5 definitions stay intact; downgrade restores them.
"""

import hashlib
import json
from collections.abc import Sequence
from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PLATFORM_TENANT_ID = "00000000-0000-7000-8000-000000000001"
_TEMPLATES = Path(__file__).resolve().parents[2] / "src" / "capability_registry" / "templates"
_PREVIOUS_DIR = _TEMPLATES / "v5"
_TEMPLATE_DIR = _TEMPLATES / "v6"
_PROVENANCE = {"source": "alter-authored", "set": "v6", "decision": "D18", "revision": "0016"}


def changed_files() -> list[Path]:
    """The v6 files whose bytes differ from the v5 file of the same name."""
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
                "WHERE template_id = :template_id AND provenance->>'revision' = '0016'"
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
