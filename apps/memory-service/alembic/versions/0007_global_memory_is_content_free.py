"""make a global memory row structurally unable to carry tenant content

Revision ID: 0007
Revises: 0006
Create Date: 2026-09-28

Design log §22: the Policy Store's global tier "must be structurally
incapable of holding tenant-specific content -- enforced by schema and by what
the write path physically accepts, so a mistake fails loudly rather than
silently leaking one customer's specifics into every tenant's policy."

The tier exists (0002): a global memory record is tenant-private while it is a
candidate, and on promotion `anonymize_global_content` reduces it to
categorical counts, nulls its tenant, and the row becomes readable by every
tenant. But only the application enforced the reduction. Any write reaching
the table as `policy_system_writer` -- a new code path, a manual fix -- could
store raw content with no tenant, visible to all.

This moves the rule into the schema. A memory row with no tenant must be
global and its content may hold only what the anonymizer produces: the three
marker flags, a run verdict from the run-outcome vocabulary, non-negative gate
and recovery counts, failure classes and strategies from their vocabularies,
and per-node-type counts. Free text has nowhere to go. Provenance may hold
only the promotion marker and, once reverted, the bare fact of revocation --
not its reason, which the revert path used to write onto the global row.

Existing rows are validated: global rows are only ever written by the
anonymizer, so any row this rejects is exactly the leak it exists to catch.
"""

import sqlalchemy as sa

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

_ENUM = {
    "verdict": (
        "completed_verified", "rescued", "escalated", "failed", "abandoned", "degraded",
    ),
    "failure_class": (
        "infrastructure_failure", "logic_output_failure", "timeout", "tool_permission_denial",
        "sandbox_crash", "rate_limit", "safety_violation", "unknown",
    ),
    "strategy": (
        "repair", "retry", "backoff", "swap_agent", "escalate_model", "recompile", "replan",
        "degrade", "ask_user", "terminate",
    ),
    "node_type": (
        "LLMTask", "ToolCall", "SandboxExec", "Gate", "HumanApproval", "Merge", "Synthesis",
        "MemoryWrite", "PubSub", "GroupChat", "YAMLImport",
    ),
}


def _array(values: tuple[str, ...]) -> str:
    return "ARRAY[" + ",".join(f"'{value}'" for value in values) + "]::text[]"


def upgrade() -> None:
    op.execute(
        sa.text(
            f"""
CREATE FUNCTION global_memory_content_is_anonymous(content jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_typeof(content) = 'object'
    AND content->>'schema' = 'global_memory_v1'
    AND content->'anonymized' = 'true'::jsonb
    AND content->'irreversible' = 'true'::jsonb
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_object_keys(content) AS k
      WHERE k NOT IN ('schema','anonymized','irreversible','final_verdict','gates',
                      'recovery_count','failure_classes','strategies','node_type_counts')
    )
    AND (NOT content ? 'final_verdict'
         OR content->>'final_verdict' = ANY({_array(_ENUM["verdict"])}))
    AND (NOT content ? 'gates' OR (
         jsonb_typeof(content->'gates') = 'object'
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_each(content->'gates') AS g
           WHERE g.key NOT IN ('passed','failed')
              OR jsonb_typeof(g.value) <> 'number' OR (g.value)::text::numeric < 0
         )))
    AND (NOT content ? 'recovery_count' OR (
         jsonb_typeof(content->'recovery_count') = 'number'
         AND (content->>'recovery_count')::numeric >= 0))
    AND (NOT content ? 'failure_classes' OR (
         jsonb_typeof(content->'failure_classes') = 'array'
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(content->'failure_classes') AS f
           WHERE jsonb_typeof(f) <> 'string'
              OR f #>> '{{}}' <> ALL({_array(_ENUM["failure_class"])})
         )))
    AND (NOT content ? 'strategies' OR (
         jsonb_typeof(content->'strategies') = 'array'
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(content->'strategies') AS s
           WHERE jsonb_typeof(s) <> 'string'
              OR s #>> '{{}}' <> ALL({_array(_ENUM["strategy"])})
         )))
    AND (NOT content ? 'node_type_counts' OR (
         jsonb_typeof(content->'node_type_counts') = 'object'
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_each(content->'node_type_counts') AS n
           WHERE n.key <> ALL({_array(_ENUM["node_type"])})
              OR jsonb_typeof(n.value) <> 'number' OR (n.value)::text::numeric < 0
         )))
$$;
"""
        )
    )
    op.execute(
        sa.text(
            """
CREATE FUNCTION global_memory_provenance_is_anonymous(provenance jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_typeof(provenance) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_object_keys(provenance) AS k WHERE k NOT IN ('promotion','revocation')
    )
    AND (NOT provenance ? 'revocation' OR provenance->'revocation' = '{"reverted": true}'::jsonb)
    AND jsonb_typeof(provenance->'promotion') = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_object_keys(provenance->'promotion') AS k
      WHERE k NOT IN ('evaluation_run_id','anonymized','irreversible','source_identifiers_removed')
    )
    AND provenance->'promotion'->'anonymized' = 'true'::jsonb
$$;
"""
        )
    )
    op.execute(
        sa.text(
            """
ALTER TABLE memory_records ADD CONSTRAINT memory_records_global_is_content_free CHECK (
  tenant_id IS NOT NULL OR (
    scope = 'global'
    -- A missing key makes these NULL, and a CHECK passes on NULL: coalesce so
    -- anything not provably anonymous is refused.
    AND COALESCE(global_memory_content_is_anonymous(content), false)
    AND COALESCE(global_memory_provenance_is_anonymous(provenance), false)
  )
)
"""
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "ALTER TABLE memory_records DROP CONSTRAINT IF EXISTS "
            "memory_records_global_is_content_free"
        )
    )
    op.execute(sa.text("DROP FUNCTION IF EXISTS global_memory_provenance_is_anonymous(jsonb)"))
    op.execute(sa.text("DROP FUNCTION IF EXISTS global_memory_content_is_anonymous(jsonb)"))
