# Neon Postgres for test environments

Neon is a managed Postgres used for **test environments only**. The production
database decision is open; Aurora with IAM authentication remains the default
everywhere and nothing here changes it.

Verified on Neon PostgreSQL 18.6, region AWS Asia Pacific 1 (Singapore),
2026-09-27.

## Why this needed a code change

Aurora is reached with an IAM auth token: no password exists, and the store
providers build their pool from host/port/database/user plus a signer. Neon has
no AWS IAM, so it is reached with a password in a connection string. The
services' environment readers previously hardcoded `iam` for every environment
that was not `local`, so no deployed environment could reach Neon at all.

A deployed environment now selects password authentication explicitly:

    DATABASE_AUTHENTICATION=static

IAM stays the default when the variable is absent, so an Aurora deployment is
unaffected. `static` is never inferred from a failure to reach IAM -- an
environment that means to use IAM fails closed instead of silently falling back
to a password.

## Two rules that are not optional

**1. Services never connect as `neondb_owner`.** That role holds `BYPASSRLS`
(through `neon_superuser`), so a service connecting as it has row-level
security silently switched off, with no error anywhere. Every tenant policy in
the migrations becomes decoration. `neondb_owner` is for running migrations.

**2. Service roles are created in SQL, by the migrations.** A role created
through the Neon console or API is granted `neon_superuser`, which carries
`BYPASSRLS` -- so a role created "the easy way" bypasses every tenant policy. A
role created by the migrations (`CREATE ROLE ... LOGIN PASSWORD ...`) has no
such membership. Probed directly: a SQL-created login role has
`rolbypassrls = f`, no `neon_superuser` membership, and reads through RLS are
filtered correctly.

## Endpoints

Neon gives each project a direct and a pooled (PgBouncer, transaction mode)
endpoint.

- **Services use the pooled endpoint.** Tenant scoping sets
  `app.current_tenant_id` with `set_config(..., true)`, which is
  transaction-local and therefore safe under transaction pooling. No code here
  uses `LISTEN`/`NOTIFY`, advisory locks, or session-level `SET ROLE`.
- **Migrations use the direct endpoint.** Drizzle and Alembic run DDL.

TLS is mandatory and enforced in code: a static connection string reaching a
non-loopback host must set `sslmode` to `require`, `verify-ca` or `verify-full`,
or the store refuses to build a pool (`staticPoolConfig`,
`packages/adapters/src/postgres/static-connection.ts`). Certificates are
verified even for `require`, which is stricter than libpq; Neon presents a
publicly-trusted certificate.

Connection string shape:

    postgresql://<service_role>:<password>@ep-xxx-pooler.<region>.aws.neon.tech/<database>?sslmode=verify-full

## Environment values per service

Services reading a connection string directly (Python):

| Service | Variables |
|---|---|
| intelligence-service | `INTELLIGENCE_DB_URL`, `INTELLIGENCE_DB_URL_SYNC`, `INTELLIGENCE_DRIFT_READER_DB_URL` |
| eval-service | `EVAL_DB_URL_SYNC`, `EVAL_ADS_DB_URL`, `EVAL_INTELLIGENCE_DB_URL` |
| ads-core | `ADS_DB_URL`, `ADS_DB_URL_SYNC`, and the deletion role URL |
| memory-service | the policy database URLs |

Services resolving a credential through Secrets Manager (TypeScript):

| Service | Variables |
|---|---|
| audit-service | `DATABASE_AUTHENTICATION=static`, `AUDIT_DATABASE_SECRET_REF` (or `DATABASE_SECRET_REF`) |
| cost-ledger-service | `DATABASE_AUTHENTICATION=static`, `COST_DATABASE_SECRET_REF` (or `DATABASE_SECRET_REF`) |
| orchestration-service | `ORCHESTRATION_DATABASE_AUTHENTICATION=static` (or `DATABASE_AUTHENTICATION`), `ORCHESTRATION_DATABASE_URL` |

platform-api takes `DATABASE_URL` and `MARKETPLACE_DATABASE_URL`, which are
already URLs and need no change.

The password belongs in the secret store, never in a committed env file and
never in Terraform state.

## Extensions

`pgcrypto`, `vector` (0.8.6), `pg_trgm` and `btree_gist` all install on Neon,
which covers every `CREATE EXTENSION` in the migrations.

## Known gaps

- **Postgres major version.** CI's testcontainers pin `postgres:16.6-alpine`
  while Neon runs 18. Tenant isolation is now proven on both
  (`conversation-goal-state-rls.spec.ts` takes `POSTGRES_TEST_IMAGE`), but the
  rest of the suite is proven only on 16.6. Aligning CI is a separate change.
- **Region.** Neon has no `ap-south-1`, so this is Singapore. Acceptable for
  test data only. Note that `audit-service` and `cost-ledger-service` still
  require `ALTER_REGION=ap-south-1` to boot, which is about the service's own
  region, not the database's.
- **Project layout.** One Neon project per environment, and ADS belongs in its
  own project to preserve the separation `modules/data/tests/database_separation.tftest.hcl`
  asserts. The Free plan may cap project count.
