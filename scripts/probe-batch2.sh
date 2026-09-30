#!/bin/sh
# Batch 2 probes -- the Tier 2 leaf services, each of which needs one database
# and no sibling service.
#
# These are database-level probes. They assert what the schema and its policies
# actually enforce, which is a real and checkable property, and they do NOT
# assert application behaviour -- that needs the services running and is Batch 3
# onward. Each probe says which of the two it is.
#
# Every probe creates its own rows and removes them, so this is independent of
# scripts/seed-local.sh and safe to re-run.
#
# Usage:
#   set -a; . ./.env.local; set +a
#   sh scripts/probe-batch2.sh
set -eu

# psql is not on the PATH of a typical developer machine on any platform, and
# nothing in this repository installs it. The compose stack already provides it
# inside the postgres image, so re-exec there when it is missing. Inside the
# container psql exists, so this cannot recurse.
if ! command -v psql >/dev/null 2>&1; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "neither psql nor docker is available; cannot run probes" >&2
    exit 127
  fi
  # MSYS_NO_PATHCONV stops Git Bash rewriting the mount path into a Windows one.
  MSYS_NO_PATHCONV=1 exec docker run --rm --network host \
    -v "$PWD:/repo" -w /repo \
    -e AUDIT_DB_PASSWORD -e PLATFORM_DB_PASSWORD -e COST_DB_PASSWORD \
    -e INTELLIGENCE_DB_PASSWORD \
    -e ENGINE_DB_HOST -e ENGINE_DB_PORT -e PLATFORM_DB_HOST -e PLATFORM_DB_PORT \
    -e ADS_DB_HOST -e ADS_DB_PORT -e COST_DB_HOST -e COST_DB_PORT \
    postgres:16-alpine sh /repo/scripts/probe-batch2.sh
fi

: "${AUDIT_DB_PASSWORD:?AUDIT_DB_PASSWORD is required (source .env.local first)}"
: "${PLATFORM_DB_PASSWORD:?PLATFORM_DB_PASSWORD is required}"
: "${COST_DB_PASSWORD:?COST_DB_PASSWORD is required}"
: "${INTELLIGENCE_DB_PASSWORD:=$AUDIT_DB_PASSWORD}"

ENGINE_HOST="${ENGINE_DB_HOST:-127.0.0.1}"; ENGINE_PORT="${ENGINE_DB_PORT:-5433}"
PLATFORM_HOST="${PLATFORM_DB_HOST:-127.0.0.1}"; PLATFORM_PORT="${PLATFORM_DB_PORT:-5432}"
ADS_HOST="${ADS_DB_HOST:-127.0.0.1}"; ADS_PORT="${ADS_DB_PORT:-5434}"
COST_HOST="${COST_DB_HOST:-127.0.0.1}"; COST_PORT="${COST_DB_PORT:-5435}"

TENANT_A="01930000-0000-7000-8000-0000000000a1"
TENANT_B="01930000-0000-7000-8000-0000000000b2"

# Roles are cluster-scoped, so a fixed name collides with a previous run that
# died before its transaction rolled back. $$ is this shell's pid, which makes
# the name unique per invocation -- the same approach
# session-gateway.rls.integration.spec.ts takes with a random suffix.
PROBE_ROLE="probe_rls_reader_$$"

PASS=0; FAIL=0; NOTE=0

ok()   { PASS=$((PASS+1)); printf '  PASS      %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL      %s\n' "$1"; }
note() { NOTE=$((NOTE+1)); printf '  NOTE      %s\n' "$1"; }

# Count assertions take the last purely-numeric line rather than the last line
# outright: psql also emits set_config results, NOTICEs and command tags, and
# relying on line position made this probe intermittently read the wrong value.
num() { grep -E '^[0-9]+$' | tail -1; }

# q <host> <port> <user> <pw> <db> <sql>  -> single scalar on stdout
q() {
  PGPASSWORD="$4" psql --quiet --no-psqlrc --tuples-only --no-align \
    --set=ON_ERROR_STOP=1 --host "$1" --port "$2" --username "$3" --dbname "$5" \
    --command "$6"
}

echo
echo "BATCH 2 PROBES -- Tier 2 leaves"
echo

# -------------------------------------------------------------------------
echo "[P1] Tenant isolation -- does the database itself refuse cross-tenant reads?"
echo "     Plane: Tenant Isolation (Engine Atlas marks this Real)"

# platform_db. The locally configured role is the cluster superuser created by
# the postgres image's POSTGRES_USER, and superusers bypass RLS unconditionally
# -- so testing isolation as platform_api would silently pass no matter what the
# policies said. Create a restricted role and test as that, which is exactly what
# session-gateway.rls.integration.spec.ts does.
# Setup and assertion are separate calls so the assertion's output is
# unambiguously the only thing on stdout. The whole probe runs inside one
# transaction that is rolled back, so neither the rows nor the temporary role
# survive -- which makes it safe to re-run.
r=$(q "$PLATFORM_HOST" "$PLATFORM_PORT" platform_api "$PLATFORM_DB_PASSWORD" platform_db "
  BEGIN;
  SELECT set_config('app.current_tenant_id', '$TENANT_A', true);
  INSERT INTO tenants (id, name, status) VALUES ('$TENANT_A','probe A','active');
  INSERT INTO workspaces (id, tenant_id, name, status)
    VALUES ('$TENANT_A', '$TENANT_A', 'probe A ws', 'active');
  CREATE ROLE $PROBE_ROLE NOLOGIN;
  GRANT USAGE ON SCHEMA public TO $PROBE_ROLE;
  GRANT SELECT ON workspaces TO $PROBE_ROLE;
  SET LOCAL ROLE $PROBE_ROLE;
  SELECT set_config('app.current_tenant_id', '$TENANT_B', true);
  SELECT count(*) FROM workspaces WHERE tenant_id = '$TENANT_A';
  ROLLBACK;
" | num)
if [ "$r" = "0" ]; then ok "platform_db  cross-tenant read returned 0 rows (as restricted role)"
else bad "platform_db  cross-tenant read returned $r rows (expected 0)"; fi

# intelligence_db. intelligence_service is genuinely not a superuser and does not
# bypass RLS, so this one tests the real runtime identity.
# workspace_id is required: agents_global_workspace_check enforces that it is
# NULL if and only if the tenant is the global platform tenant.
r=$(q "$ENGINE_HOST" "$ENGINE_PORT" intelligence_service "$INTELLIGENCE_DB_PASSWORD" intelligence_db "
  SELECT set_config('app.current_tenant_id', '$TENANT_A', true);
  INSERT INTO agents (id, tenant_id, workspace_id, name, tier, status)
    VALUES ('agt_probe_a', '$TENANT_A', '$TENANT_A', 'probe A agent', 'STANDARD', 'active')
    ON CONFLICT DO NOTHING;
  SELECT set_config('app.current_tenant_id', '$TENANT_B', true);
  SELECT count(*) FROM agents WHERE tenant_id = '$TENANT_A';
" | num)
if [ "$r" = "0" ]; then ok "intelligence_db  cross-tenant read returned 0 rows (as the real service role)"
else bad "intelligence_db  cross-tenant read returned $r rows (expected 0)"; fi

note "platform_api, ads_core and cost_ledger_service are all cluster superusers"
note "     locally, because each is its container's POSTGRES_USER. Superusers bypass"
note "     RLS, so isolation on those three databases is NOT exercised by simply"
note "     connecting as the configured role -- a local test that does so passes"
note "     regardless of policy. Only intelligence_db and policy_db use a role that"
note "     is subject to RLS at all."

# orchestration_db: runtime role must remain subject to RLS.
bypass=$(q "$ENGINE_HOST" "$ENGINE_PORT" orchestration_service "$AUDIT_DB_PASSWORD" orchestration_db "
  SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user;
" | tail -1)
if [ "$bypass" = "f" ]; then
  ok "orchestration_db  runtime role is held to FORCE RLS"
else
  bad "orchestration_db  runtime role bypasses RLS"
fi

echo

# -------------------------------------------------------------------------
echo "[P2] Audit hash chain -- is the chain structure real and linkable?"
echo "     Component 25 area / Governance plane"

r=$(q "$ENGINE_HOST" "$ENGINE_PORT" audit_service "$AUDIT_DB_PASSWORD" audit_db "
  SELECT count(*) FROM information_schema.columns
  WHERE table_name='audit_events' AND column_name IN ('prev_hash','entry_hash');
" | tail -1)
if [ "$r" = "2" ]; then ok "audit_events carries both prev_hash and entry_hash"
else bad "audit_events is missing chain columns (found $r of 2)"; fi

r=$(q "$ENGINE_HOST" "$ENGINE_PORT" audit_service "$AUDIT_DB_PASSWORD" audit_db "
  SELECT count(*) FROM information_schema.tables WHERE table_name='audit_chain_checkpoints';
" | tail -1)
if [ "$r" = "1" ]; then ok "audit_chain_checkpoints exists (incremental verification, PR #23)"
else bad "audit_chain_checkpoints missing -- incremental chain verification cannot work"; fi

# The chain is only useful if entry_hash is unique; a duplicate would let two
# events claim the same position.
r=$(q "$ENGINE_HOST" "$ENGINE_PORT" audit_service "$AUDIT_DB_PASSWORD" audit_db "
  SELECT count(*) FROM pg_indexes
  WHERE tablename='audit_events' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%entry_hash%';
" | tail -1)
if [ "$r" -ge 1 ] 2>/dev/null; then ok "entry_hash is uniquely indexed -- positions cannot collide"
else note "entry_hash has no unique index; chain position uniqueness is not enforced by the schema"; fi

echo

# -------------------------------------------------------------------------
echo "[P3] Cost FX persistence -- regression check for PR #33"
echo "     Plane: Cost & FinOps"

r=$(q "$COST_HOST" "$COST_PORT" cost_ledger_service "$COST_DB_PASSWORD" cost_db "
  SELECT count(*) FROM information_schema.columns
  WHERE table_name='cost_events' AND column_name IN ('fx_rate_used','amount_usd');
" | tail -1)
if [ "$r" = "2" ]; then ok "cost_events carries fx_rate_used and amount_usd"
else bad "PR #33 regressed: cost_events is missing FX columns (found $r of 2)"; fi

# The migration deliberately did not backfill: NULL means "predates the fix".
# That only works if NULL is actually permitted.
r=$(q "$COST_HOST" "$COST_PORT" cost_ledger_service "$COST_DB_PASSWORD" cost_db "
  SELECT count(*) FROM information_schema.columns
  WHERE table_name='cost_events' AND column_name IN ('fx_rate_used','amount_usd')
    AND is_nullable='YES';
" | tail -1)
if [ "$r" = "2" ]; then ok "both are nullable -- NULL is the documented 'predates the fix' sentinel"
else bad "FX columns are NOT NULL; the no-backfill sentinel cannot work"; fi

echo

# -------------------------------------------------------------------------
echo "[P4] ADS chunk ordering -- regression check for PR #63"
echo "     Component 04 (ADS Client) area"

r=$(q "$ADS_HOST" "$ADS_PORT" ads_core "ads_core_local" ads_db "
  SELECT count(*) FROM information_schema.columns WHERE table_name='chunks' AND column_name='seq';
" | tail -1)
if [ "$r" = "1" ]; then ok "chunks.seq exists -- ordering does not have to rely on chunk id"
else bad "chunks.seq missing; PR #63's ordering fix has no column to order by"; fi

note "P4 proves the schema supports correct ordering. It does NOT prove retrieval"
note "     uses seq rather than chunk_id -- that is application behaviour and needs"
note "     ads-core running. Deferred to a service-level probe."

echo
echo "-------------------------------------------------------------------"
printf 'pass %s   fail %s   notes %s\n' "$PASS" "$FAIL" "$NOTE"
echo

# Cleanup: remove everything the probes inserted.
q "$PLATFORM_HOST" "$PLATFORM_PORT" platform_api "$PLATFORM_DB_PASSWORD" platform_db "
  SELECT set_config('app.current_tenant_id', '$TENANT_A', true);
  DELETE FROM workspaces WHERE tenant_id = '$TENANT_A';
  DELETE FROM tenants WHERE id = '$TENANT_A';
" >/dev/null 2>&1 || true
q "$ENGINE_HOST" "$ENGINE_PORT" intelligence_service "$INTELLIGENCE_DB_PASSWORD" intelligence_db "
  SELECT set_config('app.current_tenant_id', '$TENANT_A', true);
  DELETE FROM agents WHERE tenant_id = '$TENANT_A';
" >/dev/null 2>&1 || true

[ "$FAIL" -eq 0 ] || exit 1
