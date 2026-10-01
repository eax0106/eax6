#!/usr/bin/env bash
# Proves bootstrap.sh's step 2 -- the .env the EC2 services run with -- without
# a host: runs it in a bash 5 container on a copy of the repository, with the
# AWS CLI stubbed, and asserts every rewrite rule. Prints "bootstrap-env-ok".
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# One tar reading the list on stdin: xargs would split a long list into
# several archives, and the reader stops at the first one's end.
(cd "$repo" && git ls-files -z | tar --null -T - -cf -) | tar xf - -C "$work"
mkdir -p "$work/deploy/ec2"
cp "$repo/deploy/ec2/bootstrap.sh" "$repo/deploy/ec2/operator.env.example" "$work/deploy/ec2/"
printf 'ALTER_ENV=dev\n' >"$work/deploy/ec2/host.env"
sed -e 's/=<[^>]*>/=value/' \
    -e 's#^ALTER_DOMAIN=.*#ALTER_DOMAIN=app.example.test#' \
    -e 's#^AUTH0_DOMAIN=.*#AUTH0_DOMAIN=tenant.example.auth0.com#' \
    "$work/deploy/ec2/operator.env.example" >"$work/deploy/ec2/operator.env"
mkdir -p "$work/stub"
cat >"$work/stub/aws" <<'STUB'
#!/bin/sh
case "$*" in
  *delivery-kit*) echo '{"configurationSet":"alter-dev-delivery"}' ;;
  *) echo stubbed-secret-value ;;
esac
STUB
chmod +x "$work/stub/aws"

# The container runs as root; ownership goes back to the caller so the 0600
# files can be read below (Docker Desktop hides this on macOS, Linux does not).
docker run --rm -v "$work:/repo" -w /repo/deploy/ec2 -e PATH="/repo/stub:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  bash:5 bash -c 'apk add --no-cache openssl python3 >/dev/null; bash bootstrap.sh --env-only;
    cp .db-roles.env .db-roles.first; bash bootstrap.sh --env-only;
    chown "$HOST_UID:$HOST_GID" .env .env.base .db-roles.env .db-roles.first .session.env' >/dev/null

env_file="$work/deploy/ec2/.env"
fail() { echo "FAIL $*"; exit 1; }
value() { awk -F= -v k="$1" '$1==k{v=substr($0,length(k)+2)} END{print v}' "$env_file"; }
grep -qE '^AWS_ENDPOINT_URL=' "$env_file" && fail "AWS_ENDPOINT_URL survived (would route AWS calls to LocalStack)"
grep -qE '^AWS_EC2_METADATA_DISABLED=' "$env_file" && fail "AWS_EC2_METADATA_DISABLED survived (would hide the instance role)"
grep -qE '^[A-Za-z_][A-Za-z0-9_]*=.*\$\{' "$env_file" && fail "unexpanded \${...} left: $(grep -m1 -E '^[A-Za-z_][A-Za-z0-9_]*=.*\$\{' "$env_file")"
grep -qE '^[A-Za-z_][A-Za-z0-9_]*=<' "$env_file" && fail "placeholder left: $(grep -m1 -E '^[A-Za-z_][A-Za-z0-9_]*=<' "$env_file")"
[[ "$(value ACTOR_TOKEN_SIGNING_KEY_REF)" == /alter/dev/* ]] || fail "environment reference not moved to /alter/dev/"
[[ "$(value DELETION_SERVICE_TOKEN_REF)" == alter/dev/* ]] || fail "unslashed environment reference not moved"
[[ "$(value TAVILY_API_KEY_SECRET_REF)" == /alter/local/tool-gateway/tavily-api-key ]] || fail "shared vendor reference was rewritten"
[[ "$(value ALTER_ENV)" == dev ]] || fail "ALTER_ENV is $(value ALTER_ENV)"
[[ "$(value RUNTIME_MODE)" == real && "$(value ALTER_CONFIG_SOURCE)" == appconfig ]] || fail "not real/appconfig"
[[ "$(value DATABASE_AUTHENTICATION)" == static ]] || fail "not static database authentication"
[[ "$(value AUTH0_JWKS_URL)" == https://tenant.example.auth0.com/.well-known/jwks.json ]] || fail "JWKS URL not derived"
[[ "$(value TEMPORAL_API_KEY)" == stubbed-secret-value ]] || fail "Temporal key not resolved from its secret"
[[ "$(value SES_CONFIGURATION_SET_NAME)" == alter-dev-delivery ]] || fail "SES configuration set not read from Terraform kit"
[[ "$(value SES_EVENT_WEBHOOK_SECRET)" =~ ^[0-9a-f]{64}$ ]] || fail "SES webhook key missing"
[[ "$(value ENGINE_DB_PORT)" =~ ^[0-9]+$ ]] || fail "ENGINE_DB_PORT not a number: $(value ENGINE_DB_PORT)"
[[ -n "$(value MODEL_GATEWAY_APPCONFIG_APPLICATION_ID)" ]] || fail "scoped AppConfig identifiers missing"
for key in MODEL_GATEWAY_APPCONFIG_ENVIRONMENT_ID MODEL_GATEWAY_APPCONFIG_CONFIGURATION_PROFILE_ID; do
  [[ -n "$(value "$key")" ]] || fail "$key missing"
done
[[ "$(value COST_LEDGER_BASE_URL)" == "http://127.0.0.1:$(value COST_PORT)" ]] || fail "cost-ledger HTTP address does not match its port"
[[ "$(stat -c %a "$env_file" 2>/dev/null || stat -f %Lp "$env_file")" == 600 ]] || fail ".env is not 0600"
# Task 6.1c: the services never connect as the platform_db superuser.
roles_file="$work/deploy/ec2/.db-roles.env"
[[ "$(value DATABASE_URL)" == postgresql://platform_app:*@127.0.0.1:*/platform_db ]] || fail "DATABASE_URL is not the platform_app role: $(value DATABASE_URL | sed 's#:[^:@]*@#:***@#')"
[[ "$(value MARKETPLACE_DATABASE_URL)" == postgresql://platform_app:* ]] || fail "MARKETPLACE_DATABASE_URL is not the platform_app role"
[[ "$(value PLATFORM_RETENTION_DATABASE_URL)" == postgresql://platform_retention:*@127.0.0.1:*/platform_db ]] || fail "retention URL is not the dedicated role"
[[ "$(value OPERATIONS_PLATFORM_DATABASE_URL)" == postgresql://platform_operations:* ]] || fail "OPERATIONS_PLATFORM_DATABASE_URL is not the platform_operations role"
[[ "$(value OPERATIONS_MARKETPLACE_DATABASE_URL)" == postgresql://platform_operations:* ]] || fail "OPERATIONS_MARKETPLACE_DATABASE_URL is not the platform_operations role"
for job in NOTIFICATION_DIGEST_SYSTEM_DATABASE_URL CONNECTOR_HEALTH_SWEEP_SYSTEM_DATABASE_URL; do
  [[ "$(value "$job")" == postgresql://platform_operations:* ]] || fail "$job is not the platform_operations role"
done
grep -q "$(awk -F= '$1=="PLATFORM_APP_DB_PASSWORD"{print $2}' "$roles_file")" <<<"$(value DATABASE_URL)" || fail "DATABASE_URL does not carry the generated role password"
cmp -s "$roles_file" "$work/deploy/ec2/.db-roles.first" || fail "role passwords changed on a re-run"
[[ "$(stat -c %a "$roles_file" 2>/dev/null || stat -f %Lp "$roles_file")" == 600 ]] || fail ".db-roles.env is not 0600"
# KEEP_ENV_AT=<path>: leave a copy of the generated .env for
# check-production-config.ts (task 6.1d), which needs the repository's
# dependencies and so runs on the host rather than in this container.
if [[ -n "${KEEP_ENV_AT:-}" ]]; then cp "$env_file" "$KEEP_ENV_AT"; chmod 600 "$KEEP_ENV_AT"; fi
echo "bootstrap-env-ok"
