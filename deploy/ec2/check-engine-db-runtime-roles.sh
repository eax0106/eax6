#!/usr/bin/env bash
# Verifies source-controlled engine-db role hardening. The behavioral proof is
# the orchestration runtime-RLS integration spec; this catches deployment or
# bootstrap drift before it can reach a host.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
init="$root/infrastructure/local/engine-db-init.sh"
bootstrap="$root/deploy/ec2/bootstrap.sh"
migration="$root/apps/orchestration-service/drizzle/0042_restrict_webhook_resolver_rls.sql"

grep -Fq "ALTER ROLE orchestration_service WITH LOGIN NOBYPASSRLS" "$init"
! grep -Fq "ALTER ROLE orchestration_service BYPASSRLS" "$init"
grep -Fq "ALTER ROLE orchestration_service NOBYPASSRLS" "$bootstrap"
grep -Fq "engine_db_runtime_role" "$bootstrap"
grep -Fq 'CREATE POLICY "webhook_endpoints_public_resolver"' "$migration"
grep -Fq 'CREATE POLICY "webhook_endpoint_secrets_public_resolver"' "$migration"
grep -Fq "rolname = 'orchestration_service'" "$migration"
grep -Fq "REVOKE ALL ON FUNCTION resolve_webhook_endpoint(text) FROM PUBLIC" "$migration"
grep -Fq 'GRANT EXECUTE ON FUNCTION resolve_webhook_endpoint(text) TO "orchestration_service"' "$migration"
echo engine-db-runtime-roles-ok
