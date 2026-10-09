#!/bin/sh
# Seed a freshly migrated local stack with the minimum fixtures the component
# probes need. Idempotent: safe to re-run, every insert is ON CONFLICT DO
# NOTHING.
#
# Identifiers are fixed rather than generated. A probe needs to reference the
# rows it is asserting against, so determinism matters more than realism here.
# They are valid UUIDv7 values (version nibble 7, variant 8) because the
# contracts package validates that shape at the API boundary.
#
# Note on identifier shape: tenant_id and workspace_id are BARE uuid columns in
# every database, while the API layer expects the ten_/ws_ prefixed form. That
# split is real and is what made trigger-bindings unreachable in production
# until PR #29. Seed the bare uuid; prefix it when calling an HTTP or gRPC
# surface.
#
# Usage:
#   set -a; . ./.env.local; set +a
#   sh scripts/seed-local.sh
set -eu

# psql is not on the PATH of a typical developer machine, and nothing here
# installs it. The compose stack already provides it inside the postgres image,
# so re-exec there when it is missing. Inside the container psql exists, so this
# cannot recurse.
if ! command -v psql >/dev/null 2>&1; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "neither psql nor docker is available; cannot seed" >&2
    exit 127
  fi
  # MSYS_NO_PATHCONV stops Git Bash rewriting the mount path into a Windows one.
  MSYS_NO_PATHCONV=1 exec docker run --rm --network host \
    -v "$PWD:/repo" -w /repo \
    -e AUDIT_DB_PASSWORD -e PLATFORM_DB_PASSWORD -e INTELLIGENCE_DB_PASSWORD \
    -e ORCHESTRATION_DB_PASSWORD \
    -e ENGINE_DB_HOST -e ENGINE_DB_PORT -e PLATFORM_DB_HOST -e PLATFORM_DB_PORT \
    postgres:16-alpine sh /repo/scripts/seed-local.sh
fi

: "${AUDIT_DB_PASSWORD:?AUDIT_DB_PASSWORD is required (source .env.local first)}"
: "${PLATFORM_DB_PASSWORD:?PLATFORM_DB_PASSWORD is required}"
: "${INTELLIGENCE_DB_PASSWORD:=$AUDIT_DB_PASSWORD}"
: "${ORCHESTRATION_DB_PASSWORD:=$AUDIT_DB_PASSWORD}"

PLATFORM_HOST="${PLATFORM_DB_HOST:-127.0.0.1}"
PLATFORM_PORT="${PLATFORM_DB_PORT:-5432}"
ENGINE_HOST="${ENGINE_DB_HOST:-127.0.0.1}"
ENGINE_PORT="${ENGINE_DB_PORT:-5433}"

# --- fixed fixture identifiers -------------------------------------------
TENANT_ID="01930000-0000-7000-8000-000000000001"
WORKSPACE_ID="01930000-0000-7000-8000-000000000002"
USER_ID="01930000-0000-7000-8000-000000000003"

# Two agents that differ ONLY in recorded latency and token count. Their
# capability embedding and their verdicts are identical, so anything that
# routes on cost or latency must separate them and anything that does not
# cannot. This is the fixture the Selection & Binding probe depends on.
AGENT_FAST="agt_01930000-0000-7000-8000-000000000010"
AGENT_SLOW="agt_01930000-0000-7000-8000-000000000011"

WORKFLOW_ID="wf_01930000-0000-7000-8000-000000000020"
WORKFLOW_VERSION_ID="wfv_01930000-0000-7000-8000-000000000021"
TRIGGER_ID="trg_01930000-0000-7000-8000-000000000030"
TRIGGER_VERSION_ID="trgv_01930000-0000-7000-8000-000000000031"

run_sql() {
  # run_sql <host> <port> <user> <password> <database> <label>
  PGPASSWORD="$4" psql \
    --quiet --no-psqlrc --set=ON_ERROR_STOP=1 \
    --host "$1" --port "$2" --username "$3" --dbname "$5" \
    >/dev/null
  echo "  seeded $6"
}

echo "seeding local stack"

# --- platform_db: the root identities everything else references ----------
run_sql "$PLATFORM_HOST" "$PLATFORM_PORT" platform_api "$PLATFORM_DB_PASSWORD" platform_db "platform_db (tenant, workspace, user)" <<SQL
INSERT INTO tenants (id, name, status)
VALUES ('$TENANT_ID', 'Local Probe Tenant', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspaces (id, tenant_id, name, status)
VALUES ('$WORKSPACE_ID', '$TENANT_ID', 'Local Probe Workspace', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, identity_ref, email, display_name, status)
VALUES ('$USER_ID', 'auth0|$USER_ID', 'probe@local.invalid', 'Probe User', 'active')
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.current_tenant_id', '$TENANT_ID', false);
INSERT INTO tenant_members (id, tenant_id, user_id, role)
VALUES (gen_random_uuid(), '$TENANT_ID', '$USER_ID', 'owner')
ON CONFLICT (tenant_id, user_id) DO NOTHING;
INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role)
VALUES (gen_random_uuid(), '$TENANT_ID', '$WORKSPACE_ID', '$USER_ID', 'admin')
ON CONFLICT (workspace_id, user_id) DO NOTHING;

SQL

# --- intelligence_db: the Selection & Binding fixture ---------------------
run_sql "$ENGINE_HOST" "$ENGINE_PORT" intelligence_service "$INTELLIGENCE_DB_PASSWORD" intelligence_db "intelligence_db (2 agents, identical except cost/latency)" <<SQL
-- Every table here is tenant-scoped with FORCE ROW LEVEL SECURITY, so the
-- tenant context must be set before any insert. This is the same mechanism
-- the services use via withTenant; seeding without it fails closed, which is
-- the correct behaviour.
SELECT set_config('app.current_tenant_id', '$TENANT_ID', false);

INSERT INTO agents (id, tenant_id, workspace_id, name, tier, status)
VALUES
  ('$AGENT_FAST', '$TENANT_ID', '$WORKSPACE_ID', 'probe-agent-cheap-fast', 'STANDARD', 'active'),
  ('$AGENT_SLOW', '$TENANT_ID', '$WORKSPACE_ID', 'probe-agent-costly-slow', 'STANDARD', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO agent_versions (id, agent_id, tenant_id, version_number, capabilities, model_alias)
VALUES
  ('${AGENT_FAST}-v1', '$AGENT_FAST', '$TENANT_ID', 1, '["text.summarization"]'::jsonb, 'STANDARD'),
  ('${AGENT_SLOW}-v1', '$AGENT_SLOW', '$TENANT_ID', 1, '["text.summarization"]'::jsonb, 'STANDARD')
ON CONFLICT (id) DO NOTHING;

-- Identical embeddings on purpose: capability_similarity must be equal so it
-- cannot be what separates the two agents.
INSERT INTO capability_embeddings (id, agent_id, tenant_id, capability_description, embedding)
VALUES
  ('${AGENT_FAST}-emb', '$AGENT_FAST', '$TENANT_ID', 'summarize text', array_fill(0.01::real, ARRAY[512])::vector),
  ('${AGENT_SLOW}-emb', '$AGENT_SLOW', '$TENANT_ID', 'summarize text', array_fill(0.01::real, ARRAY[512])::vector)
ON CONFLICT (id) DO NOTHING;

-- Identical verdicts (so performance_score matches) but latency and token
-- count differ by roughly an order of magnitude. Both columns exist and are
-- populated; neither appears in the scoring formula.
INSERT INTO performance_records (id, agent_id, tenant_id, node_type, task_category, verdict, latency_ms, token_count)
VALUES
  ('${AGENT_FAST}-perf-1', '$AGENT_FAST', '$TENANT_ID', 'llm', 'summarization', 'success', 120, 400),
  ('${AGENT_FAST}-perf-2', '$AGENT_FAST', '$TENANT_ID', 'llm', 'summarization', 'success', 140, 420),
  ('${AGENT_SLOW}-perf-1', '$AGENT_SLOW', '$TENANT_ID', 'llm', 'summarization', 'success', 4200, 9000),
  ('${AGENT_SLOW}-perf-2', '$AGENT_SLOW', '$TENANT_ID', 'llm', 'summarization', 'success', 4400, 9400)
ON CONFLICT (id) DO NOTHING;
SQL

# --- orchestration_db: a workflow to launch runs against ------------------
run_sql "$ENGINE_HOST" "$ENGINE_PORT" orchestration_service "$ORCHESTRATION_DB_PASSWORD" orchestration_db "orchestration_db (workflow + compiled version)" <<SQL
SELECT set_config('app.current_tenant_id', '$TENANT_ID', false);

INSERT INTO workflows (id, tenant_id, workspace_id, name, status)
VALUES ('$WORKFLOW_ID', '$TENANT_ID', '$WORKSPACE_ID', 'probe-workflow', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_versions (
  id, tenant_id, workflow_id, version, compiled_dag, dag_schema_version, status
)
VALUES (
  '$WORKFLOW_VERSION_ID', '$TENANT_ID', '$WORKFLOW_ID', 1,
  '{"schema_version":"1","entry_node_keys":["start"],"nodes":[{"key":"start","type":"LLMTask","config":{"model_alias":"FAST","prompt":"Say hello."},"metadata":{"ui":{}}}],"edges":[],"waves":[{"key":"w1","order":0,"node_keys":["start"],"depends_on":[]}]}'::jsonb,
  '1', 'compiled'
)
ON CONFLICT (id) DO NOTHING;

-- RunDispatchService.CreateRun resolves the trigger and its active version
-- before it will insert an events row. Without both, every dispatch is a
-- silent no-op that returns an empty response and creates nothing.
INSERT INTO triggers (id, tenant_id, workspace_id, workflow_id, name, type, status)
VALUES ('$TRIGGER_ID', '$TENANT_ID', '$WORKSPACE_ID', '$WORKFLOW_ID', 'probe-trigger', 'manual', 'enabled')
ON CONFLICT (id) DO NOTHING;

INSERT INTO trigger_versions (
  id, tenant_id, trigger_id, version, workflow_version_id, config, status, activated_at
)
VALUES (
  '$TRIGGER_VERSION_ID', '$TENANT_ID', '$TRIGGER_ID', 1,
  '$WORKFLOW_VERSION_ID', '{}'::jsonb, 'active', now()
)
ON CONFLICT (id) DO NOTHING;
SQL

cat <<EOF

seeded. fixture identifiers:

  tenant      $TENANT_ID
  workspace   $WORKSPACE_ID
  user        $USER_ID
  agent fast  $AGENT_FAST
  agent slow  $AGENT_SLOW
  workflow    $WORKFLOW_ID
  version     $WORKFLOW_VERSION_ID
  trigger     $TRIGGER_ID

Prefix tenant and workspace with ten_ / ws_ when calling an API surface;
the databases store the bare uuid.
EOF
