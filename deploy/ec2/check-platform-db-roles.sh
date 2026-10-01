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
cleanup() {
  # Only this check's generated fixture IDs, in the migration-owner transaction.
  psql_as "$url" -c "BEGIN; SET LOCAL session_replication_role = replica; DELETE FROM tenant_members WHERE user_id = '$user_id'; DELETE FROM users WHERE id = '$user_id'; DELETE FROM tenants WHERE id IN ('$tenant_a', '$tenant_b'); COMMIT;" >/dev/null 2>&1 || true
}
trap cleanup EXIT
psql_as "$url" -c "
  INSERT INTO tenants (id, name, status) VALUES ('$tenant_a', 'roles-check-a', 'active'), ('$tenant_b', 'roles-check-b', 'active');
  INSERT INTO users (id, identity_ref, email, status) VALUES ('$user_id', 'check|$user_id', 'roles-check@example.test', 'active');
  INSERT INTO tenant_members (id, tenant_id, user_id, role) VALUES (gen_random_uuid(), '$tenant_a', '$user_id', 'owner'), (gen_random_uuid(), '$tenant_b', '$user_id', 'member');" >/dev/null

members="tenant_members WHERE user_id = '$user_id'"
[[ "$(psql_as "$app" -c "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")" == f ]] \
  || fail "platform_app is a superuser or bypasses RLS"
[[ "$(psql_as "$app" -c "SELECT count(*) FROM $members")" == 0 ]] \
  || fail "platform_app read tenant rows with no tenant context (RLS not applied)"
[[ "$(psql_as "$app" -c "SELECT set_config('app.current_tenant_id', '$tenant_a', false)" -c "SELECT count(*) FROM $members" | tail -1)" == 1 ]] \
  || fail "platform_app did not see exactly its own tenant's row"
[[ "$(psql_as "$app" -c "SELECT count(*) FROM admin_list_users('$user_id')")" == 1 ]] \
  || fail "platform_app cannot use the staff definer functions"
[[ "$(psql_as "$ops" -c "SELECT count(*) FROM $members")" == 2 ]] \
  || fail "platform_operations does not read across tenants"
for role_target in "$app" "$ops"; do
  if psql_as "$role_target" -c "ALTER TABLE tenant_members ADD COLUMN roles_check int" >/dev/null 2>&1; then
    fail "a runtime role could change the schema"
  fi
done
echo "platform-db-roles-ok"
