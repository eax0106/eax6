-- Cluster-admin provisioning; runtime migration never creates a role.
SELECT format('CREATE ROLE audit_retention LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', :'retention_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_retention') \gexec
ALTER ROLE audit_retention WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'retention_password';
GRANT CONNECT ON DATABASE audit_db TO audit_retention;
