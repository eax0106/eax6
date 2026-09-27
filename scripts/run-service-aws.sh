#!/usr/bin/env bash
# Run one gateway service against real AWS (AppConfig, Secrets Manager, SSM,
# Bedrock) while the rest of the local stack keeps talking to LocalStack.
# Task 1.6: every gateway service must start this way from committed
# configuration alone.
#
# Usage:
#   bash scripts/run-service-aws.sh <service>           # run in the foreground
#   bash scripts/run-service-aws.sh <service> --check   # boot, prove, stop
#
# <service> is one of: model-gateway, tool-gateway, sandbox-service,
# provisioning-service.
#
# --check reads .env.local.example, never .env.local, so it proves the
# committed file rather than a developer's local edits. It builds the service,
# starts it with RUNTIME_MODE=real and ALTER_CONFIG_SOURCE=appconfig, waits for
# /health to answer {"status":"ok","service":"<service>"} (the identity, not
# just a 200), stops it, and prints "<service> boot-ok". Anything else exits
# non-zero with the service's own log tail.
#
# Why a script rather than lines in the env file: AWS_ENDPOINT_URL is global to
# the SDK, so a process that needs real AWS must not have it, while the rest of
# the stack must. One shared file cannot say both.
#
# Credentials come from the operator's AWS credential chain; set
# ALTER_AWS_PROFILE to pick a named profile.
set -euo pipefail

# Git Bash rewrites values that look like Unix paths; every secret reference
# here starts with a slash.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

service="${1:-}"
mode="${2:-run}"
case "$service" in
  model-gateway) prefix=MODEL_GATEWAY; port_var=MODEL_GATEWAY_PORT ;;
  tool-gateway) prefix=TOOL_GATEWAY; port_var=TOOL_GATEWAY_PORT ;;
  sandbox-service) prefix=SANDBOX_SERVICE; port_var=SANDBOX_SERVICE_PORT ;;
  provisioning-service) prefix=PROVISIONING_SERVICE; port_var=PROVISIONING_SERVICE_PORT ;;
  *)
    echo "run-service-aws: usage: $0 <model-gateway|tool-gateway|sandbox-service|provisioning-service> [--check]" >&2
    exit 2
    ;;
esac
if [[ "$mode" != "run" && "$mode" != "--check" ]]; then
  echo "run-service-aws: unknown option $mode" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

env_file=.env.local
[[ "$mode" == "--check" || ! -f "$env_file" ]] && env_file=.env.local.example

# Read the file as dotenv, not as shell: the committed example carries
# <placeholder> values for things these services never read (database
# passwords), which a shell cannot even parse. Only ${VAR:-default} is
# expanded; an unfilled <placeholder> is left unset, so a service that does
# need it fails on its own validation instead of starting with a fake value.
load_env_file() {
  local line key raw value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    raw="${BASH_REMATCH[2]}"
    [[ "$raw" == *"<"*">"* ]] && continue
    value="$raw"
    while [[ "$value" =~ \$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\} ]]; do
      local ref="${BASH_REMATCH[1]}" fallback="${BASH_REMATCH[2]}"
      value="${value/"${BASH_REMATCH[0]}"/${!ref:-$fallback}}"
    done
    export "$key=$value"
  done <"$1"
}
load_env_file "./$env_file"

# The variables that decide whether AWS calls reach AWS.
unset AWS_ENDPOINT_URL AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
unset AWS_EC2_METADATA_DISABLED
[[ -n "${ALTER_AWS_PROFILE:-}" ]] && export AWS_PROFILE="$ALTER_AWS_PROFILE"
export AWS_REGION="${ALTER_REGION:-ap-south-1}"

export RUNTIME_MODE=real ALTER_CONFIG_SOURCE=appconfig ALTER_SERVICE_NAME="$service"

# Each service reads the unscoped APPCONFIG_* names; the committed file holds
# one scoped set per service. A service with no scoped set reads no AppConfig.
for part in APPLICATION_ID ENVIRONMENT_ID CONFIGURATION_PROFILE_ID; do
  scoped="${prefix}_APPCONFIG_${part}"
  if [[ -n "${!scoped:-}" ]]; then
    export "APPCONFIG_${part}=${!scoped}"
  else
    unset "APPCONFIG_${part}"
  fi
done

main="dist/apps/$service/main.js"
if [[ "$mode" == "run" ]]; then
  [[ -f "$main" ]] || { echo "run-service-aws: $main not found; run 'pnpm exec nx build $service'" >&2; exit 1; }
  exec node "$main"
fi

pnpm exec nx build "$service" --skip-nx-cache >/dev/null

# AppConfig is read lazily, on a service's first policy lookup, so a clean
# boot says nothing about the identifiers. Fetch the policy the service would
# fetch, with the same identifiers, and validate it against the contract.
if [[ -n "${APPCONFIG_APPLICATION_ID:-}" ]]; then
  policy="$(mktemp)"
  token="$(aws appconfigdata start-configuration-session \
    --application-identifier "$APPCONFIG_APPLICATION_ID" \
    --environment-identifier "$APPCONFIG_ENVIRONMENT_ID" \
    --configuration-profile-identifier "$APPCONFIG_CONFIGURATION_PROFILE_ID" \
    --query InitialConfigurationToken --output text 2>&1)" || {
    echo "run-service-aws: $service AppConfig identifiers do not resolve: $token" >&2
    rm -f "$policy"; exit 1; }
  aws appconfigdata get-latest-configuration --configuration-token "$token" "$policy" >/dev/null
  if ! node -e '
    const { ModelAliasPolicySchema } = require("./packages/contracts/dist/model-alias-policy.js");
    ModelAliasPolicySchema.parse(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")));
  ' "$policy"; then
    echo "run-service-aws: $service AppConfig policy does not match ModelAliasPolicySchema" >&2
    rm -f "$policy"; exit 1
  fi
  rm -f "$policy"
fi
port="${!port_var:?$port_var is not set in $env_file}"
if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "run-service-aws: port $port is already in use; stop whatever holds it first" >&2
  exit 1
fi

log="$(mktemp)"
node "$main" >"$log" 2>&1 &
pid=$!
cleanup() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -f "$log"; }
trap cleanup EXIT

expected="{\"status\":\"ok\",\"service\":\"$service\"}"
for _ in $(seq 1 60); do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "run-service-aws: $service exited during startup" >&2
    tail -n 40 "$log" >&2
    exit 1
  fi
  body="$(curl -fsS "http://127.0.0.1:$port/health" 2>/dev/null || true)"
  if [[ "$body" == "$expected" ]]; then
    if grep -qiE "mock (provider|mode)|RUNTIME_MODE=mock" "$log"; then
      echo "run-service-aws: $service reported a mock path while RUNTIME_MODE=real" >&2
      tail -n 40 "$log" >&2
      exit 1
    fi
    echo "$service boot-ok (real, appconfig, $env_file, health=$body)"
    exit 0
  fi
  if [[ -n "$body" ]]; then
    echo "run-service-aws: port $port answered as someone else: $body" >&2
    exit 1
  fi
  sleep 1
done
echo "run-service-aws: $service did not answer /health within 60s" >&2
tail -n 40 "$log" >&2
exit 1
