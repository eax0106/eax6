#!/usr/bin/env bash
# Proves deploy/ec2/platform-db-roles.sql (task 6.1c) against a migrated
# platform_db: the tenant-plane role is held to row-level security, the
# staff-plane role reads across tenants, neither can change the schema, and
# the definer functions still answer. Prints "platform-db-roles-ok".
#
# Usage: check-platform-db-roles.sh <superuser URL of a migrated platform_db>
# (CI passes its migrated service database). Uses the host's psql, or the
# postgres image's when there is none.
set -euo pipefail
url="${1:?usage: check-platform-db-roles.sh <superuser database URL>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_password="check-app-$RANDOM$RANDOM"
ops_password="check-ops-$RANDOM$RANDOM"
retention_password="check-retention-$RANDOM$RANDOM"

psql_as() { # <url> <sql...>: one value, no decoration
  local target="$1"; shift
  if command -v psql >/dev/null; then
    psql "$target" -X -qAt -v ON_ERROR_STOP=1 "$@"
  else
    docker run --rm -i --network host postgres:16-alpine psql "$target" -X -qAt -v ON_ERROR_STOP=1 "$@"
  fi
}
role_url() { # <role> <password>
  python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(p._replace(netloc=f"{sys.argv[2]}:{sys.argv[3]}@{p.hostname}:{p.port or 5432}").geturl())' "$url" "$1" "$2"
}
fail() { echo "FAIL $*"; exit 1; }

psql_as "$url" -v app_password="$app_password" -v operations_password="$ops_password" -v retention_password="$retention_password" <"$here/platform-db-roles.sql" >/dev/null
# Twice, as bootstrap.sh runs it: the second run must be a no-op, not an error.
psql_as "$url" -v app_password="$app_password" -v operations_password="$ops_password" -v retention_password="$retention_password" <"$here/platform-db-roles.sql" >/dev/null

app="$(role_url platform_app "$app_password")"
ops="$(role_url platform_operations "$ops_password")"
retention="$(role_url platform_retention "$retention_password")"
if [[ "$(psql_as "$url" -c "SELECT to_regprocedure('expire_erasure_skeleton(timestamptz)') IS NOT NULL")" == t ]]; then
  for role_target in "$app" "$ops"; do
    if psql_as "$role_target" -c "SELECT expire_erasure_skeleton(NULL)" >/dev/null 2>&1; then
      fail "expiry requires the dedicated retention connection"
    fi
  done
  [[ "$(psql_as "$retention" -c "SELECT expire_erasure_skeleton(NULL)")" == 0 ]] || fail "dedicated retention expiry unavailable"
  if psql_as "$retention" -c 'SELECT * FROM tenants LIMIT 1' >/dev/null 2>&1; then
    fail "retention role has general table access"
  fi
fi
tenant_a="$(python3 -c 'import uuid; print(uuid.uuid4())')"
tenant_b="$(python3 -c 'import uuid; print(uuid.uuid4())')"
user_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
workspace_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
invitation_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
organization_id="org_${tenant_a//-/}"
ticket_hash="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())' "$invitation_id")"
cleanup() {
  # Only this check's generated fixture IDs, in the migration-owner transaction.
  psql_as "$url" -c "BEGIN; SET LOCAL session_replication_role = replica; DELETE FROM workspace_invitations WHERE id = '$invitation_id'; DELETE FROM workspace_members WHERE user_id = '$user_id'; DELETE FROM tenant_members WHERE user_id = '$user_id'; DELETE FROM workspaces WHERE id = '$workspace_id'; DELETE FROM users WHERE id = '$user_id'; DELETE FROM tenants WHERE id IN ('$tenant_a', '$tenant_b'); COMMIT;" >/dev/null 2>&1 || true
}
trap cleanup EXIT
psql_as "$url" -c "
  INSERT INTO tenants (id, name, status) VALUES ('$tenant_a', 'roles-check-a', 'active'), ('$tenant_b', 'roles-check-b', 'active');
  UPDATE tenants SET identity_org_ref='$organization_id' WHERE id='$tenant_a';
  INSERT INTO users (id, identity_ref, email, status) VALUES ('$user_id', 'check|$user_id', 'roles-check@example.test', 'active');
  INSERT INTO tenant_members (id, tenant_id, user_id, role) VALUES (gen_random_uuid(), '$tenant_a', '$user_id', 'owner'), (gen_random_uuid(), '$tenant_b', '$user_id', 'member');
  INSERT INTO workspaces (id, tenant_id, name, status) VALUES ('$workspace_id', '$tenant_a', 'roles-check', 'active');
  INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role) VALUES (gen_random_uuid(), '$tenant_a', '$workspace_id', '$user_id', 'admin');
  INSERT INTO workspace_invitations (id,tenant_id,workspace_id,email,role,status,invited_by,provider_org_ref,provider_invitation_id,provider_ticket_hash)
    VALUES ('$invitation_id','$tenant_a','$workspace_id','invitee@roles-check.test','approver','pending','$user_id','$organization_id','uinv_roles_check','$ticket_hash');" >/dev/null

members="tenant_members WHERE user_id = '$user_id'"
[[ "$(psql_as "$app" -c "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")" == f ]] \
  || fail "platform_app is a superuser or bypasses RLS"
[[ "$(psql_as "$app" -c "SELECT count(*) FROM $members")" == 0 ]] \
  || fail "platform_app read tenant rows with no tenant context (RLS not applied)"
[[ "$(psql_as "$app" -c "SELECT set_config('app.current_tenant_id', '$tenant_a', false)" -c "SELECT count(*) FROM $members" | tail -1)" == 1 ]] \
  || fail "platform_app did not see exactly its own tenant's row"
[[ "$(psql_as "$app" -c "SELECT set_config('app.current_tenant_id', '$tenant_a', false)" -c "UPDATE workspaces SET name='roles-check-edited' WHERE id='$workspace_id' RETURNING name" | tail -1)" == roles-check-edited ]] \
  || fail "tenant data update unavailable"
[[ "$(psql_as "$app" -c "SELECT count(*) FROM resolve_existing_signup('check|$user_id', '$tenant_a') WHERE \"userId\" = '$user_id' AND \"workspaceId\" = '$workspace_id'")" == 1 ]] \
  || fail "tenant signup lookup unavailable"
[[ "$(psql_as "$app" -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND p.oid NOT IN ('resolve_existing_signup(text,uuid)'::regprocedure,'resolve_workspace_invitation(text,text,text)'::regprocedure,'resolve_existing_organization_member(text,text)'::regprocedure,'erase_tenant_action_annotations(uuid,text)'::regprocedure,'erase_tenant_payout_ledger(uuid,text)'::regprocedure,'erase_tenant_listings(uuid,text)'::regprocedure,'erase_tenant_marketplace_governance(uuid,text)'::regprocedure,'erase_tenant_abuse_signal_actions(uuid,text)'::regprocedure,'erase_tenant_billing_admin_operations(uuid,text)'::regprocedure,'erase_tenant_credit_purchases(uuid,text)'::regprocedure) AND has_function_privilege(current_user,p.oid,'EXECUTE')")" == 0 ]] \
  || fail "tenant function grant check failed"
[[ "$(psql_as "$app" -c "SELECT count(*) FROM workspace_invitations WHERE id='$invitation_id'")" == 0 ]] \
  || fail "invitation rows require tenant context"
[[ "$(psql_as "$app" -c "SELECT count(*) FROM resolve_workspace_invitation('$organization_id','invitee@roles-check.test','$ticket_hash') WHERE \"invitationId\"='$invitation_id' AND \"workspaceId\"='$workspace_id'")" == 1 ]] \
  || fail "exact invitation bootstrap unavailable"
for context in "'$organization_id','other@roles-check.test','$ticket_hash'" "'org_wrong','invitee@roles-check.test','$ticket_hash'" "'$organization_id','invitee@roles-check.test','invalid-hash'"; do
  [[ "$(psql_as "$app" -c "SELECT count(*) FROM resolve_workspace_invitation($context)")" == 0 ]] \
    || fail "invitation bootstrap accepted mismatched context"
done
[[ "$(psql_as "$app" -c "SELECT count(*) FROM resolve_existing_organization_member('check|$user_id','$organization_id') WHERE \"userId\"='$user_id' AND \"workspaceId\"='$workspace_id'")" == 1 ]] \
  || fail "exact organization membership bootstrap unavailable"
[[ "$(psql_as "$app" -c "SELECT count(*) FROM resolve_existing_organization_member('check|unknown','$organization_id')")" == 0 ]] \
  || fail "organization bootstrap accepted unknown identity"
[[ "$(psql_as "$app" -c "SELECT count(*) FROM resolve_existing_organization_member('check|$user_id','org_wrong')")" == 0 ]] \
  || fail "organization bootstrap accepted wrong organization"
for call in 'admin_list_tenants()' "admin_list_users('$user_id')" "admin_revoke_user_sessions('$user_id')" 'admin_list_billing_issues()' 'admin_list_staff_billing_issues()' 'list_billing_sync_tenants(NULL,100)' 'pseudonymise_orphan_users(ARRAY[]::uuid[])' 'list_platform_tenant_ids()' 'list_due_credit_purchases(100)'; do
  if psql_as "$app" -c "SELECT $call" >/dev/null 2>&1; then
    fail "tenant and staff function grants must differ"
  fi
done
[[ "$(psql_as "$ops" -c "SELECT count(*) FROM admin_list_users('$user_id')")" == 1 ]] \
  || fail "staff user lookup unavailable"
[[ "$(psql_as "$ops" -c "SELECT count(*) FROM admin_list_tenants() WHERE id IN ('$tenant_a','$tenant_b')")" == 2 ]] \
  || fail "staff tenant lookup unavailable"
psql_as "$ops" -c 'SELECT count(*) FROM admin_list_billing_issues()' >/dev/null
[[ "$(psql_as "$ops" -c "SELECT admin_revoke_user_sessions('$user_id')")" == 0 ]] \
  || fail "staff session operation unavailable"
[[ "$(psql_as "$ops" -c "SELECT count(*) FROM $members")" == 2 ]] \
  || fail "platform_operations does not read across tenants"
for role_target in "$app" "$ops"; do
  if psql_as "$role_target" -c "ALTER TABLE tenant_members ADD COLUMN roles_check int" >/dev/null 2>&1; then
    fail "a runtime role could change the schema"
  fi
done
echo "platform-db-roles-ok"
