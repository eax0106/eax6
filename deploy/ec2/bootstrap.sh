#!/usr/bin/env bash
# Brings up the single-EC2 MVP (task 6.1) from this repository on the host.
# Idempotent: re-running keeps generated passwords and secrets, re-applies
# migrations (no-ops when current), rebuilds the web bundle and restarts
# changed containers.
#
# Needs, next to this file:
#   host.env      written by the instance's user data (ALTER_ENV)
#   operator.env  copied from operator.env.example and filled by the operator
# and the instance role from infrastructure/ec2-mvp.
#
# Steps:
#   1. .env.base  -- once: scripts/bootstrap-env-local.sh generates every
#                    password and token (kept across re-runs)
#   2. .env       -- .env.base rewritten for this environment and real AWS,
#                    plus the operator's settings and the secrets they name
#   3. secrets    -- the environment's generated secrets, created if absent
#                    (the same set infrastructure/local/localstack-init makes)
#   4. data       -- Postgres x4, Redis, Presidio; wait until healthy; the
#                    platform_db runtime roles (platform-db-roles.sql)
#   5. migrate    -- platform, orchestration, and the four alembic services
#                    (audit and cost-ledger migrate themselves at startup);
#                    platform_db as its superuser, then the roles' privileges
#   6. web        -- build the platform-web bundle for ALTER_DOMAIN
#   7. services   -- everything, then every /health
#
# --env-only stops after step 2 (used by check-bootstrap-env.sh).
# ALTER_BOOTSTRAP_LOCAL=1 skips step 3 and the AWS-specific rewrites so the same
# script can be proven on a workstation against LocalStack.
set -euo pipefail
((BASH_VERSINFO[0] >= 4)) || { echo "bootstrap: needs bash 4+ (Amazon Linux 2023 has 5)" >&2; exit 1; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$here"
umask 077

log() { printf 'bootstrap: %s\n' "$*"; }
die() { printf 'bootstrap: %s\n' "$*" >&2; exit 1; }

[[ -f host.env ]] || die "host.env missing (written by the instance user data)"
[[ -f operator.env ]] || die "operator.env missing: copy operator.env.example and fill it"
set -a
# shellcheck disable=SC1091
. ./host.env
# shellcheck disable=SC1091
. ./operator.env
set +a
: "${ALTER_ENV:?}" "${ALTER_DOMAIN:?}" "${ALTER_REGISTRY:?}" "${ALTER_IMAGE_TAG:?}"
if grep -qE '=<' operator.env; then die "operator.env still has <placeholder> values"; fi
local_mode="${ALTER_BOOTSTRAP_LOCAL:-0}"

secret() { aws secretsmanager get-secret-value --secret-id "$1" --query SecretString --output text; }

# --- 1. generated base ---------------------------------------------------------
if [[ ! -f .env.base ]]; then
  log "generating .env.base (passwords and tokens, kept across re-runs)"
  (cd "$repo" && bash scripts/bootstrap-env-local.sh --out "$here/.env.base" --from .env.local.example)
fi

# --- 1b. platform_db runtime role passwords (kept across re-runs) ----------------
# The platform_db superuser (POSTGRES_USER platform_api) bypasses row-level
# security, so it only migrates; the services connect as platform_app and, for
# the staff plane, platform_operations (platform-db-roles.sql, task 6.1c).
if [[ ! -f .db-roles.env ]]; then
  printf 'PLATFORM_APP_DB_PASSWORD=%s\nPLATFORM_OPERATIONS_DB_PASSWORD=%s\n' \
    "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" >.db-roles.env
fi
# shellcheck disable=SC1091
. ./.db-roles.env
# platform-api's session cookie signing key, generated once like the above.
if [[ ! -f .session.env ]]; then
  printf 'SESSION_COOKIE_SIGNING_KEY=%s\n' "$(openssl rand -hex 32)" >.session.env
fi
# shellcheck disable=SC1091
. ./.session.env

# --- 2. environment file ------------------------------------------------------
log "writing .env for ALTER_ENV=$ALTER_ENV"
shared_refs='^(TAVILY_API_KEY_SECRET_REF|BROWSERBASE_API_KEY_REF|E2B_API_KEY_REF|PLATFORM_ADMIN_SERVICE_TOKEN_SECRET_REF)='
# `docker run --env-file` passes values through literally, so the ${VAR:-default}
# forms .env.base keeps are expanded here, against values seen earlier in the file.
declare -A seen=()
expand() {
  local value="$1" ref fallback
  while [[ "$value" =~ \$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\} ]]; do
    ref="${BASH_REMATCH[1]}" fallback="${BASH_REMATCH[2]}"
    value="${value/"${BASH_REMATCH[0]}"/${seen[$ref]:-$fallback}}"
  done
  printf '%s' "$value"
}
{
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="$(expand "${BASH_REMATCH[2]}")"
      line="$key=$value"
      seen[$key]="$value"
    fi
    if [[ "$local_mode" != 1 ]]; then
      # LocalStack routing and the metadata switch would hide the instance role.
      [[ "$line" =~ ^(AWS_ENDPOINT_URL|AWS_EC2_METADATA_DISABLED|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)= ]] && continue
      # Environment-scoped references move to this environment; the vendor
      # secrets shared with local keep their names.
      if [[ ! "$line" =~ $shared_refs ]]; then
        line="${line//\/alter\/local\//\/alter\/$ALTER_ENV\/}"
        line="${line//=alter\/local\//=alter\/$ALTER_ENV\/}"
      fi
    fi
    printf '%s\n' "$line"
  done <.env.base
  printf '\n# --- EC2 MVP overrides (deploy/ec2/bootstrap.sh) ---\n'
  if [[ "$local_mode" != 1 ]]; then
    printf 'ALTER_ENV=%s\nNODE_ENV=production\nRUNTIME_MODE=real\nALTER_CONFIG_SOURCE=appconfig\nDATABASE_AUTHENTICATION=static\n' "$ALTER_ENV"
    printf 'AUTH0_DOMAIN=%s\nAUTH0_JWKS_URL=https://%s/.well-known/jwks.json\n' "$AUTH0_DOMAIN" "$AUTH0_DOMAIN"
    printf 'AUTH0_M2M_TOKEN_URL=https://%s/oauth/token\n' "$AUTH0_DOMAIN"
    printf 'API_AUDIENCE=%s\nAUTH0_API_AUDIENCE=%s\nAUTH0_M2M_AUDIENCE=%s\n' "$AUTH0_API_AUDIENCE" "$AUTH0_API_AUDIENCE" "$AUTH0_API_AUDIENCE"
    printf 'AUTH0_M2M_CLIENT_ID=%s\nAUTH0_M2M_CLIENT_SECRET=%s\n' "$AUTH0_M2M_CLIENT_ID" "$(secret "$AUTH0_M2M_CLIENT_SECRET_REF")"
    printf 'TEMPORAL_ADDRESS=%s\nTEMPORAL_NAMESPACE=%s\nPLATFORM_TEMPORAL_NAMESPACE=%s\n' "$TEMPORAL_ADDRESS" "$TEMPORAL_NAMESPACE" "$TEMPORAL_NAMESPACE"
    printf 'TEMPORAL_API_KEY=%s\n' "$(secret "$TEMPORAL_API_KEY_SECRET_REF")"
    printf 'TEMPORAL_WORKER_DEPLOYMENT_NAME=%s\nTEMPORAL_WORKER_BUILD_ID=%s\n' "$TEMPORAL_WORKER_DEPLOYMENT_NAME" "$ALTER_IMAGE_TAG"
    printf 'TEMPORAL_MINIMUM_RETENTION_DAYS=%s\n' "$TEMPORAL_MINIMUM_RETENTION_DAYS"
    printf 'AUTH0_STAFF_DOMAIN=%s\nAUTH0_STAFF_CLIENT_ID=%s\n' "$AUTH0_STAFF_DOMAIN" "$AUTH0_STAFF_CLIENT_ID"
    # Production refuses every mock at boot (task 6.1d, check-production-boot.sh):
    # real identity, email and media providers, and the Session Gateway flag.
    # platform-api resolves a *_REF as the name of an environment variable
    # (identity.module.ts resolveRuntimeSecret), so the values are resolved
    # from Secrets Manager here and the references point at them.
    printf 'IDENTITY_PROVIDER=auth0\nAUTH0_CLIENT_ID=%s\n' "$AUTH0_CLIENT_ID"
    printf 'AUTH0_CLIENT_SECRET=%s\nAUTH0_CLIENT_SECRET_REF=env:AUTH0_CLIENT_SECRET\n' "$(secret "$AUTH0_CLIENT_SECRET_REF")"
    printf 'AUTH0_M2M_CLIENT_SECRET_REF=env:AUTH0_M2M_CLIENT_SECRET\n'
    printf 'SESSION_COOKIE_SIGNING_KEY=%s\nSESSION_COOKIE_SIGNING_KEY_REF=env:SESSION_COOKIE_SIGNING_KEY\n' "$SESSION_COOKIE_SIGNING_KEY"
    # tool-gateway resolves SES_CREDENTIALS_SECRET_REF in Secrets Manager;
    # platform-api reads SES_CREDENTIALS_JSON instead (compose.yml override).
    printf 'EMAIL_PROVIDER=ses\nSES_FROM_ADDRESS=%s\nSES_CREDENTIALS_SECRET_REF=%s\n' "$SES_FROM_ADDRESS" "$SES_CREDENTIALS_SECRET_REF"
    printf 'SES_CREDENTIALS_JSON=%s\n' "$(secret "$SES_CREDENTIALS_SECRET_REF")"
    media_bucket="$(aws ssm get-parameter --name "/alter/$ALTER_ENV/orchestration/artifacts-bucket" --query Parameter.Value --output text)"
    printf 'MEDIA_OBJECT_STORAGE_PROVIDER=s3\nIMAGE_GEN_PROVIDER=titan\nTEXT_TO_SPEECH_PROVIDER=polly\nSPEECH_TO_TEXT_PROVIDER=transcribe\nMEDIA_BUCKET_NAME=%s\n' "$media_bucket"
    printf 'INGRESS_SESSION_GATEWAY_CORE_ENABLED=true\n'
    # Inside the environment's own parameter path, which the host role can read.
    printf 'SELECTION_BINDING_FAIL_CLOSED_PARAM=/alter/%s/orchestration/selection-binding-fail-closed\n' "$ALTER_ENV"
  fi
  printf 'ALTER_DOMAIN=%s\nALTER_REGISTRY=%s\nALTER_IMAGE_TAG=%s\n' "$ALTER_DOMAIN" "$ALTER_REGISTRY" "$ALTER_IMAGE_TAG"
  platform_db="127.0.0.1:${seen[PLATFORM_DB_PORT]:-5432}/platform_db"
  printf 'DATABASE_URL=postgresql://platform_app:%s@%s\n' "$PLATFORM_APP_DB_PASSWORD" "$platform_db"
  printf 'MARKETPLACE_DATABASE_URL=postgresql://platform_app:%s@%s\n' "$PLATFORM_APP_DB_PASSWORD" "$platform_db"
  printf 'OPERATIONS_PLATFORM_DATABASE_URL=postgresql://platform_operations:%s@%s\n' "$PLATFORM_OPERATIONS_DB_PASSWORD" "$platform_db"
  printf 'OPERATIONS_MARKETPLACE_DATABASE_URL=postgresql://platform_operations:%s@%s\n' "$PLATFORM_OPERATIONS_DB_PASSWORD" "$platform_db"
  # The two cross-tenant platform jobs (notification digests, connector health
  # sweep) fail closed without their own bypass-RLS pool.
  printf 'NOTIFICATION_DIGEST_SYSTEM_DATABASE_URL=postgresql://platform_operations:%s@%s\n' "$PLATFORM_OPERATIONS_DB_PASSWORD" "$platform_db"
  printf 'CONNECTOR_HEALTH_SWEEP_SYSTEM_DATABASE_URL=postgresql://platform_operations:%s@%s\n' "$PLATFORM_OPERATIONS_DB_PASSWORD" "$platform_db"
} >.env
chmod 600 .env
if [[ "${1:-}" == "--env-only" ]]; then log "wrote .env (--env-only)"; exit 0; fi

# Later lines win in env files, but compose interpolation and the services read
# the same file, so read it back the way they will.
env_value() { awk -F= -v k="$1" '$1==k{v=substr($0,length(k)+2)} END{print v}' .env; }

# --- 3. generated secrets -------------------------------------------------------
put_secret_if_absent() {
  local name="$1" value="$2"
  if aws secretsmanager describe-secret --secret-id "$name" >/dev/null 2>&1; then return 0; fi
  aws secretsmanager create-secret --name "$name" --secret-string "$value" >/dev/null
  log "created secret $name"
}
if [[ "$local_mode" != 1 ]]; then
  audit_dsn="postgresql://audit_service:$(env_value AUDIT_DB_PASSWORD)@127.0.0.1:$(env_value ENGINE_DB_PORT)/audit_db"
  cost_dsn="postgresql://cost_ledger_service:$(env_value COST_DB_PASSWORD)@127.0.0.1:$(env_value COST_DB_PORT)/cost_db"
  put_secret_if_absent "$(env_value AUDIT_DATABASE_SECRET_REF)" "$audit_dsn"
  put_secret_if_absent "$(env_value COST_DATABASE_SECRET_REF)" "$cost_dsn"
  put_secret_if_absent "$(env_value DELETION_SERVICE_TOKEN_REF)" "$(openssl rand -hex 32)"
  put_secret_if_absent "$(env_value DELETION_PSEUDONYM_KEY_REF)" "$(openssl rand -hex 32)"
  put_secret_if_absent "$(env_value COST_PSEUDONYM_KEY_REF)" "$(openssl rand -hex 32)"
  signing_ref="$(env_value ACTOR_TOKEN_SIGNING_KEY_REF)"
  if ! aws ssm get-parameter --name "$signing_ref" >/dev/null 2>&1; then
    key="$(mktemp)"
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$key" >/dev/null 2>&1
    aws ssm put-parameter --name "$signing_ref" --type SecureString --value "file://$key" >/dev/null
    rm -f "$key"
    log "created actor-token signing key $signing_ref"
  fi
fi

compose() { docker compose -f compose.yml --env-file .env "$@"; }

# --- 4. data --------------------------------------------------------------------
log "starting data services"
compose up -d --wait platform-db engine-db ads-db cost-db redis presidio-analyzer presidio-anonymizer
platform_db_roles() {
  compose exec -T platform-db psql -U platform_api -d platform_db -X -q -v ON_ERROR_STOP=1 \
    -v app_password="$PLATFORM_APP_DB_PASSWORD" -v operations_password="$PLATFORM_OPERATIONS_DB_PASSWORD" \
    <platform-db-roles.sql >/dev/null
}
log "platform_db runtime roles"
platform_db_roles

# --- 5. migrations ------------------------------------------------------------
node_image="$ALTER_REGISTRY/node:$ALTER_IMAGE_TAG"
# Options before the image (such as -e overrides) come first: run_node [-e K=V]... cmd...
run_node() {
  local options=()
  while [[ "${1:-}" == -e ]]; do options+=("$1" "$2"); shift 2; done
  docker run --rm --network host --env-file .env ${options[@]+"${options[@]}"} "$node_image" "$@"
}
log "migrating platform_db"
platform_admin_url="postgresql://platform_api:$(env_value PLATFORM_DB_PASSWORD)@127.0.0.1:$(env_value PLATFORM_DB_PORT)/platform_db"
run_node -e DATABASE_URL="$platform_admin_url" -e MARKETPLACE_DATABASE_URL="$platform_admin_url" \
  pnpm --filter @alterx/platform-api db:migrate
platform_db_roles
log "migrating orchestration_db"
run_node pnpm --filter @alterx/orchestration-service db:migrate
for app in ads-core intelligence-service memory-service eval-service; do
  log "migrating $app"
  docker run --rm --network host --env-file .env "$ALTER_REGISTRY/$app:$ALTER_IMAGE_TAG" alembic upgrade head
done

# --- 6. web bundle -------------------------------------------------------------
log "building the web bundle for https://$ALTER_DOMAIN"
rm -rf web && mkdir -p web
docker run --rm -u "$(id -u):$(id -g)" -v "$here/web:/out" \
  -e VITE_API_MODE=live -e VITE_API_BASE_URL="https://$ALTER_DOMAIN" \
  "$node_image" pnpm --dir apps/platform-web exec vite build --outDir /out --emptyOutDir

# --- 7. services ------------------------------------------------------------------
log "starting services"
compose up -d
log "waiting for every /health"
failed=0
for pair in \
  audit-service:AUDIT_PORT cost-ledger-service:COST_PORT \
  model-gateway:MODEL_GATEWAY_PORT tool-gateway:TOOL_GATEWAY_PORT \
  sandbox-service:SANDBOX_SERVICE_PORT provisioning-service:PROVISIONING_SERVICE_PORT \
  orchestration-service:ORCHESTRATION_PORT platform-api:PLATFORM_API_PORT \
  ads-core:ADS_CORE_PORT intelligence-service:INTELLIGENCE_SERVICE_PORT \
  verification-service:VERIFICATION_SERVICE_PORT memory-service:MEMORY_SERVICE_PORT \
  eval-service:EVAL_SERVICE_PORT; do
  svc="${pair%%:*}" port="$(env_value "${pair##*:}")"
  ok=0
  for _ in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:$port/health" 2>/dev/null | grep -q "\"$svc\""; then ok=1; break; fi
    sleep 2
  done
  if [[ "$ok" == 1 ]]; then log "healthy: $svc"; else log "NOT healthy: $svc (docker compose logs $svc)"; failed=1; fi
done
[[ "$failed" == 0 ]] || die "one or more services are not healthy"
log "stack is up: https://$ALTER_DOMAIN"
