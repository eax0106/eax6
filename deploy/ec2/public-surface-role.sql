-- Apply before migration 0053, including on existing engine-db volumes.
SELECT format('CREATE ROLE public_surface LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'public_surface_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'public_surface') \gexec
ALTER ROLE public_surface WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'public_surface_password';
GRANT CONNECT ON DATABASE orchestration_db TO public_surface;
