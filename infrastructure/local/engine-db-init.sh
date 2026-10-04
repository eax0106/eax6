#!/bin/sh
set -eu

# Only AUDIT_DB_PASSWORD is required. Every other role falls back to it, so a
# minimal .env.local still produces a working cluster -- but that means several
# roles share one credential unless you set them explicitly. Passing each one
# through docker-compose.yml makes that visible rather than silent.
: "${AUDIT_DB_PASSWORD:?AUDIT_DB_PASSWORD is required}"
: "${AUDIT_RETENTION_DB_PASSWORD:?AUDIT_RETENTION_DB_PASSWORD is required}"
: "${PUBLIC_SURFACE_DB_PASSWORD:=}"
: "${ORCHESTRATION_DB_PASSWORD:=$AUDIT_DB_PASSWORD}"
: "${INTELLIGENCE_DB_PASSWORD:=$AUDIT_DB_PASSWORD}"
: "${COST_DB_PASSWORD:=$AUDIT_DB_PASSWORD}"
: "${EVAL_DB_PASSWORD:=$AUDIT_DB_PASSWORD}"
: "${MEMORY_DB_PASSWORD:=$AUDIT_DB_PASSWORD}"
: "${POLICY_SYSTEM_WRITER_PASSWORD:=$AUDIT_DB_PASSWORD}"
: "${INTELLIGENCE_DRIFT_READER_PASSWORD:=$AUDIT_DB_PASSWORD}"

psql \
  --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname postgres \
  --set=audit_db_password="$AUDIT_DB_PASSWORD" \
  --set=audit_retention_db_password="$AUDIT_RETENTION_DB_PASSWORD" \
  --set=public_surface_db_password="$PUBLIC_SURFACE_DB_PASSWORD" \
  --set=orchestration_db_password="$ORCHESTRATION_DB_PASSWORD" \
  --set=intelligence_db_password="$INTELLIGENCE_DB_PASSWORD" \
  --set=cost_db_password="$COST_DB_PASSWORD" \
  --set=eval_db_password="$EVAL_DB_PASSWORD" \
  --set=memory_db_password="$MEMORY_DB_PASSWORD" \
  --set=policy_system_writer_password="$POLICY_SYSTEM_WRITER_PASSWORD" \
  --set=intelligence_drift_reader_password="$INTELLIGENCE_DRIFT_READER_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE audit_service LOGIN PASSWORD %L',
  :'audit_db_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'audit_service'
) \gexec

ALTER ROLE audit_service WITH LOGIN PASSWORD :'audit_db_password';

SELECT 'CREATE DATABASE audit_db OWNER audit_service'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = 'audit_db'
) \gexec

ALTER DATABASE audit_db OWNER TO audit_service;
REVOKE CONNECT, TEMPORARY ON DATABASE audit_db FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE audit_db TO audit_service;

SELECT format('CREATE ROLE audit_retention LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', :'audit_retention_db_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_retention') \gexec
ALTER ROLE audit_retention WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'audit_retention_db_password';
GRANT CONNECT ON DATABASE audit_db TO audit_retention;

SELECT format(
  'CREATE ROLE orchestration_service LOGIN PASSWORD %L',
  :'orchestration_db_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'orchestration_service'
) \gexec

ALTER ROLE orchestration_service WITH LOGIN NOBYPASSRLS PASSWORD :'orchestration_db_password';

SELECT 'CREATE DATABASE orchestration_db OWNER orchestration_service'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = 'orchestration_db'
) \gexec

ALTER DATABASE orchestration_db OWNER TO orchestration_service;
REVOKE CONNECT, TEMPORARY ON DATABASE orchestration_db FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE orchestration_db TO orchestration_service;

SELECT format('CREATE ROLE public_surface LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'public_surface_db_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'public_surface') \gexec
ALTER ROLE public_surface WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'public_surface_db_password';
GRANT CONNECT ON DATABASE orchestration_db TO public_surface;
-- Migration 0053 supplies only scoped SELECT columns after the tables exist.


SELECT format(
  'CREATE ROLE intelligence_service LOGIN PASSWORD %L',
  :'intelligence_db_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'intelligence_service'
) \gexec

ALTER ROLE intelligence_service WITH LOGIN PASSWORD :'intelligence_db_password';

SELECT 'CREATE DATABASE intelligence_db OWNER intelligence_service'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = 'intelligence_db'
) \gexec

ALTER DATABASE intelligence_db OWNER TO intelligence_service;
REVOKE CONNECT, TEMPORARY ON DATABASE intelligence_db FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE intelligence_db TO intelligence_service;

SELECT format(
  'CREATE ROLE cost_ledger_service LOGIN PASSWORD %L',
  :'cost_db_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'cost_ledger_service'
) \gexec

ALTER ROLE cost_ledger_service WITH LOGIN PASSWORD :'cost_db_password';

SELECT 'CREATE DATABASE cost_db OWNER cost_ledger_service'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = 'cost_db'
) \gexec

ALTER DATABASE cost_db OWNER TO cost_ledger_service;
REVOKE CONNECT, TEMPORARY ON DATABASE cost_db FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE cost_db TO cost_ledger_service;

SELECT format(
  'CREATE ROLE eval_service LOGIN PASSWORD %L',
  :'eval_db_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'eval_service'
) \gexec

ALTER ROLE eval_service WITH LOGIN PASSWORD :'eval_db_password';

SELECT 'CREATE DATABASE eval_db OWNER eval_service'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = 'eval_db'
) \gexec

ALTER DATABASE eval_db OWNER TO eval_service;
REVOKE CONNECT, TEMPORARY ON DATABASE eval_db FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE eval_db TO eval_service;

-- memory-service. Its settings default to policy_db on this cluster, but
-- neither the role nor the database was ever created here, so the service
-- could not run locally at all.
SELECT format(
  'CREATE ROLE memory_service LOGIN PASSWORD %L',
  :'memory_db_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'memory_service'
) \gexec

ALTER ROLE memory_service WITH LOGIN PASSWORD :'memory_db_password';

SELECT 'CREATE DATABASE policy_db OWNER memory_service'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = 'policy_db'
) \gexec

ALTER DATABASE policy_db OWNER TO memory_service;
REVOKE CONNECT, TEMPORARY ON DATABASE policy_db FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE policy_db TO memory_service;

-- Second identity memory-service expects: policy_db_system_url_sync connects
-- as policy_system_writer for system-owned policy rows.
SELECT format(
  'CREATE ROLE policy_system_writer LOGIN PASSWORD %L',
  :'policy_system_writer_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'policy_system_writer'
) \gexec

ALTER ROLE policy_system_writer WITH LOGIN PASSWORD :'policy_system_writer_password';
GRANT CONNECT, TEMPORARY ON DATABASE policy_db TO policy_system_writer;

-- intelligence-service migration 0002 creates this role with BYPASSRLS, which
-- PostgreSQL 16 refuses from a non-superuser even with CREATEROLE. The
-- migration guards on pg_roles, so pre-creating it here lets the migration run
-- as intelligence_service and apply only its GRANTs.
SELECT format(
  'CREATE ROLE intelligence_drift_reader LOGIN BYPASSRLS PASSWORD %L',
  :'intelligence_drift_reader_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'intelligence_drift_reader'
) \gexec

ALTER ROLE intelligence_drift_reader WITH LOGIN BYPASSRLS PASSWORD :'intelligence_drift_reader_password';
GRANT CONNECT ON DATABASE intelligence_db TO intelligence_drift_reader;
SQL

# pgvector must exist before intelligence-service migration 0001 runs. The
# migration uses CREATE EXTENSION IF NOT EXISTS, but creating an extension
# requires superuser, which intelligence_service is not -- so create it here
# and the migration becomes a no-op.
psql \
  --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname intelligence_db \
  --command 'CREATE EXTENSION IF NOT EXISTS vector'
