#!/usr/bin/env bash
set -euo pipefail

# Task 1.4. The committed .env.local.example reference values must point at
# real AWS resources (SSM parameters and Secrets Manager secrets) so that
# someone with credentials can bring up the AppConfig path from committed
# configuration alone. This check lists the real AWS resource names and fails
# if any committed reference does not exist.
#
# It needs live AWS credentials, which CI does not have, so it is gated behind
# RUN_LIVE_REFERENCE_CHECK=1 (the same pattern as the live Titan embedding
# test). Run it manually with credentials:
#
#   RUN_LIVE_REFERENCE_CHECK=1 scripts/check-reference-resolution.sh
#
# It lists names only and never prints a secret value.

if [[ "${RUN_LIVE_REFERENCE_CHECK:-}" != "1" ]]; then
  echo "reference-resolution check skipped: set RUN_LIVE_REFERENCE_CHECK=1 to run against real AWS" >&2
  exit 0
fi

command -v aws >/dev/null || {
  echo "reference-resolution check failed: aws CLI not found" >&2
  exit 2
}

# Confirm credentials are present before doing any work.
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "reference-resolution check failed: no AWS credentials (aws sts get-caller-identity failed)" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/.env.local.example"

# The committed reference variables. Each value is an SSM parameter name or a
# Secrets Manager secret name. The check resolves each against the union of
# both services, so it does not need to know which service a reference targets.
reference_vars=(
  ACTOR_TOKEN_SIGNING_KEY_REF
  AUDIT_ARCHIVE_BUCKET_PARAM
  ALTER_ARTIFACTS_BUCKET_PARAM
  AUDIT_DATABASE_SECRET_REF
  AUDIT_CHAIN_CHECKPOINT_SIGNING_KEY_REF
  DELETION_SERVICE_TOKEN_REF
  DELETION_PSEUDONYM_KEY_REF
  COST_DATABASE_SECRET_REF
  COST_PSEUDONYM_KEY_REF
  TAVILY_API_KEY_SECRET_REF
  BROWSERBASE_API_KEY_REF
  E2B_API_KEY_REF
  PLATFORM_ADMIN_SERVICE_TOKEN_SECRET_REF
)

# Collect the union of existing SSM parameter names and Secrets Manager secret
# names. Names only -- never values.
existing="$(mktemp)"
trap 'rm -f "$existing"' EXIT

aws ssm get-parameters-by-path --path /alter --recursive \
  --query 'Parameters[].Name' --output text 2>/dev/null \
  | tr '\t' '\n' >>"$existing" || true
aws secretsmanager list-secrets \
  --query 'SecretList[].Name' --output text 2>/dev/null \
  | tr '\t' '\n' >>"$existing" || true

# Normalise to a sorted set for lookup.
sort -u "$existing" -o "$existing"

missing=0
for var in "${reference_vars[@]}"; do
  value="$(grep -E "^${var}=" "$env_file" | head -n1 | cut -d= -f2-)"
  if [[ -z "$value" ]]; then
    echo "reference-resolution violation: $var is not set in $env_file" >&2
    missing=1
    continue
  fi
  if ! grep -qxF "$value" "$existing"; then
    echo "reference-resolution violation: $var=$value does not exist in AWS (SSM or Secrets Manager)" >&2
    missing=1
  fi
done

# Committed AppConfig identifiers (task 1.6), one set per service. Each
# application/environment/profile triple must exist in the account.
for prefix in MODEL_GATEWAY TOOL_GATEWAY SANDBOX_SERVICE; do
  app="$(grep -E "^${prefix}_APPCONFIG_APPLICATION_ID=" "$env_file" | head -n1 | cut -d= -f2-)"
  envid="$(grep -E "^${prefix}_APPCONFIG_ENVIRONMENT_ID=" "$env_file" | head -n1 | cut -d= -f2-)"
  profile="$(grep -E "^${prefix}_APPCONFIG_CONFIGURATION_PROFILE_ID=" "$env_file" | head -n1 | cut -d= -f2-)"
  if [[ -z "$app" || -z "$envid" || -z "$profile" ]]; then
    echo "reference-resolution violation: ${prefix}_APPCONFIG_* is not fully set in $env_file" >&2
    missing=1
    continue
  fi
  if ! aws appconfig get-environment --application-id "$app" --environment-id "$envid" >/dev/null 2>&1 \
    || ! aws appconfig get-configuration-profile --application-id "$app" --configuration-profile-id "$profile" >/dev/null 2>&1; then
    echo "reference-resolution violation: ${prefix}_APPCONFIG_* ($app/$envid/$profile) does not exist in AppConfig" >&2
    missing=1
  fi
done

if [[ "$missing" -ne 0 ]]; then
  echo "reference-resolution check failed: one or more committed references do not resolve" >&2
  exit 1
fi

echo "reference-resolution check passed: all committed references resolve against real AWS"
