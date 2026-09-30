#!/bin/sh
# Parameters and secrets that services resolve during bootstrap, before they
# serve anything. Without these, audit-service aborts on its archive bucket
# parameter, orchestration-service aborts on the artifacts bucket parameter,
# and cost-ledger-service cannot resolve its database. Each failure surfaces
# as a bare ParameterNotFound or ResourceNotFoundException from the AWS SDK,
# which reads as a broken service rather than as an unseeded local stack.
set -eu

: "${COST_DB_PASSWORD:?COST_DB_PASSWORD is required}"

AUDIT_ARCHIVE_BUCKET_PARAM="${AUDIT_ARCHIVE_BUCKET_PARAM:-/alter/local/audit/archive-bucket}"
AUDIT_ARCHIVE_BUCKET="${AUDIT_ARCHIVE_BUCKET:-alter-local-audit-archive}"
AUDIT_CHAIN_CHECKPOINT_SIGNING_KEY_REF="${AUDIT_CHAIN_CHECKPOINT_SIGNING_KEY_REF:-/alter/local/audit-service/system/audit-chain-checkpoint-signing-key}"
ARTIFACTS_BUCKET_PARAM="${ARTIFACTS_BUCKET_PARAM:-/alter/local/orchestration/artifacts-bucket}"
ARTIFACTS_BUCKET="${ARTIFACTS_BUCKET:-alter-local-artifacts}"
DELETION_SERVICE_TOKEN_REF="${DELETION_SERVICE_TOKEN_REF:-alter/local/audit-service/deletion-service-token}"
DELETION_PSEUDONYM_KEY_REF="${DELETION_PSEUDONYM_KEY_REF:-alter/local/audit-service/deletion-pseudonym-key}"
COST_PSEUDONYM_KEY_REF="${COST_PSEUDONYM_KEY_REF:-/alter/local/cost-ledger-service/pseudonym-key}"
COST_DATABASE_SECRET_REF="${COST_DATABASE_SECRET_REF:-/alter/local/cost-ledger-service/database-credentials}"
COST_DB_HOST="${COST_DB_HOST:-127.0.0.1}"
COST_DB_PORT="${COST_DB_PORT:-5435}"
COST_DATABASE_NAME="${COST_DATABASE_NAME:-cost_db}"
COST_DATABASE_USER="${COST_DATABASE_USER:-cost_ledger_service}"

put_parameter() {
  awslocal ssm put-parameter --name "$1" --value "$2" --type String --overwrite >/dev/null
}

put_secret() {
  if awslocal secretsmanager describe-secret --secret-id "$1" >/dev/null 2>&1; then
    awslocal secretsmanager put-secret-value --secret-id "$1" --secret-string "$2" >/dev/null
  else
    awslocal secretsmanager create-secret --name "$1" --secret-string "$2" >/dev/null
  fi
}

awslocal s3 mb "s3://$AUDIT_ARCHIVE_BUCKET" >/dev/null 2>&1 || true
awslocal s3 mb "s3://$ARTIFACTS_BUCKET" >/dev/null 2>&1 || true
put_parameter "$AUDIT_ARCHIVE_BUCKET_PARAM" "$AUDIT_ARCHIVE_BUCKET"
put_parameter "$ARTIFACTS_BUCKET_PARAM" "$ARTIFACTS_BUCKET"

# Local-only fixture material. These are development credentials for a stack
# that only ever listens on loopback; nothing here is used outside it.
umask 077
deletion_token_file="$(mktemp)"
deletion_key_file="$(mktemp)"
checkpoint_signing_key_file="$(mktemp)"
cost_key_file="$(mktemp)"
cost_dsn_file="$(mktemp)"
trap 'rm -f "$deletion_token_file" "$deletion_key_file" "$checkpoint_signing_key_file" "$cost_key_file" "$cost_dsn_file"' EXIT

printf '%s' "${DELETION_SERVICE_TOKEN:-$(openssl rand -hex 32)}" > "$deletion_token_file"
openssl rand -hex 32 > "$deletion_key_file"
openssl rand -hex 32 > "$checkpoint_signing_key_file"
openssl rand -hex 32 > "$cost_key_file"

export COST_DATABASE_USER COST_DB_PASSWORD COST_DB_HOST COST_DB_PORT COST_DATABASE_NAME
python3 - "$cost_dsn_file" <<'PY'
import os
import pathlib
import sys
from urllib.parse import quote

user = quote(os.environ["COST_DATABASE_USER"], safe="")
password = quote(os.environ["COST_DB_PASSWORD"], safe="")
host = os.environ["COST_DB_HOST"]
port = os.environ["COST_DB_PORT"]
database = quote(os.environ["COST_DATABASE_NAME"], safe="")
pathlib.Path(sys.argv[1]).write_text(
    f"postgresql://{user}:{password}@{host}:{port}/{database}",
    encoding="utf-8",
)
PY

put_secret "$DELETION_SERVICE_TOKEN_REF" "file://$deletion_token_file"
put_secret "$DELETION_PSEUDONYM_KEY_REF" "file://$deletion_key_file"
put_secret "$AUDIT_CHAIN_CHECKPOINT_SIGNING_KEY_REF" "file://$checkpoint_signing_key_file"
put_secret "$COST_PSEUDONYM_KEY_REF" "file://$cost_key_file"
put_secret "$COST_DATABASE_SECRET_REF" "file://$cost_dsn_file"

echo "Service startup resources ready"
