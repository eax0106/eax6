"""D25 (b): tenant benchmark datasets, cases, runs and case results.

Unlike Alter's own golden sets, these rows are customer content. Forced RLS
admits eval_service only inside one tenant's context
(app.current_tenant_id); the internal golden-set context (app.eval_internal)
sees none of them. A read-only tenant inventory context
(app.eval_tenant_inventory) lists which tenants hold rows, for the
deletion-ledger replay and for closing runs a restart interrupted. Every table is
erasure-registered (eval-service deletion provider).
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = (
    "benchmark_datasets",
    "benchmark_cases",
    "benchmark_runs",
    "benchmark_case_results",
)


def upgrade() -> None:
    op.execute(
        sa.text("""
CREATE TABLE benchmark_datasets (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, workspace_id, name)
);
CREATE TABLE benchmark_cases (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  dataset_id UUID NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  input JSONB NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  success_criteria JSONB NOT NULL CHECK (
    jsonb_typeof(success_criteria) = 'array'
    AND jsonb_array_length(success_criteria) BETWEEN 1 AND 20
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (dataset_id, position),
  FOREIGN KEY (tenant_id, dataset_id)
    REFERENCES benchmark_datasets (tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE benchmark_runs (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  dataset_id UUID NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_version_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  case_count INTEGER NOT NULL CHECK (case_count BETWEEN 1 AND 100),
  passed INTEGER NOT NULL DEFAULT 0 CHECK (passed >= 0),
  failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
  errored INTEGER NOT NULL DEFAULT 0 CHECK (errored >= 0),
  pass_rate NUMERIC CHECK (pass_rate BETWEEN 0 AND 1),
  input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  estimated_cost_usd NUMERIC CHECK (estimated_cost_usd >= 0),
  error TEXT,
  requested_by TEXT NOT NULL CHECK (char_length(requested_by) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, dataset_id)
    REFERENCES benchmark_datasets (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX benchmark_runs_dataset_created
  ON benchmark_runs (tenant_id, dataset_id, created_at DESC, id DESC);
CREATE TABLE benchmark_case_results (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  run_id UUID NOT NULL,
  case_id UUID NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'error')),
  score NUMERIC,
  threshold NUMERIC,
  reviewer_model TEXT,
  output JSONB NOT NULL,
  steps JSONB NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  simulation_run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, case_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES benchmark_runs (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id) REFERENCES benchmark_cases (tenant_id, id) ON DELETE CASCADE
);
""")
    )
    for table in TABLES:
        op.execute(sa.text(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY"))
        op.execute(sa.text(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY"))
        op.execute(
            sa.text(f"""
CREATE POLICY {table}_tenant_access ON {table}
FOR ALL
USING (current_user = 'eval_service'
  AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
WITH CHECK (current_user = 'eval_service'
  AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
""")
        )
        op.execute(
            sa.text(f"""
CREATE POLICY {table}_tenant_inventory ON {table}
FOR SELECT
USING (current_user = 'eval_service'
  AND current_setting('app.eval_tenant_inventory', true) = 'on')
""")
        )


def downgrade() -> None:
    for table in reversed(TABLES):
        op.execute(sa.text(f"DROP TABLE IF EXISTS {table}"))
