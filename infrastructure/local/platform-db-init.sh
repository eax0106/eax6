#!/usr/bin/env bash
# Fresh local cluster: retention connects separately; migration 0029 grants
# only its designated expiry function. Existing volumes remain untouched.
set -euo pipefail
: "${PLATFORM_RETENTION_DB_PASSWORD:?PLATFORM_RETENTION_DB_PASSWORD required}"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -v retention_password="$PLATFORM_RETENTION_DB_PASSWORD" <<'SQL'
SELECT set_config('alter.retention_password', :'retention_password', false) AS retention_configuration
\gset
DO $role$
BEGIN
  CREATE ROLE platform_retention LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  EXECUTE format('ALTER ROLE platform_retention PASSWORD %L', current_setting('alter.retention_password'));
END
$role$;
SQL
