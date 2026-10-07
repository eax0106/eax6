# Local development

Root Compose stack runs Engine dependencies without live AWS, Temporal Cloud,
Grafana Cloud, or Sentry accounts. `platform-db` remains Platform-owned and is
not used by Engine services.

## MVP quick start

Use Node 22 (see `.nvmrc`), pnpm 9.15.9, `uv`, and Docker Desktop with
Compose v2. The AWS credential chain must already have access to the local
AppConfig/SSM/Secrets Manager references below and Bedrock in `ap-south-1`.
These scripts do not create accounts or configure cloud resources.

From the repository root:

```bash
scripts/local/mvp-up.sh
node scripts/local/mvp-smoke.mjs --health-only
node scripts/local/mvp-smoke.mjs
# Only after explicit approval for the displayed spend ceiling:
node scripts/local/mvp-smoke.mjs --apply
scripts/local/mvp-down.sh
```

Startup builds the services, starts a checkout-specific Compose project,
migrates the databases, seeds the local member, then starts the issuer and
every application. It refuses occupied ports before starting resources.
Open the printed web URL; HTTP health requires the expected service identity,
and gRPC readiness requires an HTTP/2 acknowledgement. Logs and process
ownership live in `tmp/local-mvp/`; configuration is generated once in
`.env.mvp.local`. Both are private and gitignored. Stop preserves database
volumes and credentials, and only stops resources recorded for this checkout.

The MVP startup migrates Intelligence through revision 0008 as
`intelligence_service`, runs only revision 0009 as the existing `engine_admin`
to transfer the lookup function's ownership, then applies remaining revisions
as `intelligence_service`. The administrative password is used only by that
local migration step. The application keeps its restricted runtime connection;
production migration files, grants and RLS policies are unchanged. Already
upgraded databases skip the administrative step.

Smoke signs in as the seeded mock member, lists and instantiates the meeting
notes template, supplies a small local intake, recompiles, and reads the real
run's persisted status, verification and cost. Without `--apply`, it stops
before creating a run. Email and other outside actions remain mocked.

The dedicated real Bedrock gateway reserves conservative cost **before** paid
invoke, stream, or embedding requests. It starts disarmed; `--apply` creates
a private permit for the owned Gateway process, seeded tenant and created run,
then removes it on exit. Embeddings share the tenant's allowance.
Its entire process lifetime has a
USD 0.25 allowance, including failed attempts and recovery; smoke prints this
bound first. Output is capped at 1,024 tokens, SDK attempts at one, and direct
provider failover is unavailable in this local profile. Unknown model prices
or exhausted allowance refuse the next paid request. A stack restart resets
the allowance and requires renewed spend approval before another paid smoke.
Cost Ledger's reported INR charge is distinct from AWS's USD list-price bound.

## Prerequisites

- Docker Desktop with Compose v2
- Node.js and pnpm versions declared by repository
- Run `pnpm install` once, from repo root, before anything else. A fresh
  clone has no `node_modules`; every `pnpm exec` / `pnpm exec nx run`
  command below fails without it.

## Configure

```bash
cp .env.local.example .env.local
```

Replace every angle-bracket placeholder in `.env.local` with a local-only,
shell-safe value. Never commit `.env.local`.

### Or: let the bootstrap do it (recommended)

`.env.local.example` cannot be sourced as-is — 25 uncommented lines carry
`<placeholder>` values and bash reads `<` as a redirect, so
`set -a; . .env.local.example` dies on line 11. `scripts/bootstrap-env-local.sh`
turns it into a sourceable `.env.local` in one step: it generates the six
database passwords, the `INTERNAL_SERVICE_TOKEN` and its SHA-256 (kept
consistent), and the marketplace cursor secret; propagates each password
into every connection string that interpolates it; resolves the two
placeholders the example references but never defines
(`ADS_DB_PASSWORD=ads_core_local` from the `ads-db` compose service,
`MEMORY_DB_PASSWORD=$AUDIT_DB_PASSWORD` from `engine-db-init.sh`); and never
clobbers an existing `.env.local` (use `--merge` to fill missing values while
preserving real AWS/Auth0 settings).

```bash
scripts/bootstrap-env-local.sh          # create ./.env.local (refuses if one exists)
scripts/bootstrap-env-local.sh --merge   # fill placeholders in an existing .env.local, keep real values
```

It is idempotent: re-running `--merge` does not regenerate passwords a
running database was already created with. If a stack has already run and
the Postgres volumes hold roles created with an old password, a first-time
bootstrap refuses and names the stale-volume trap rather than letting it
surface later as an authentication error. CI runs `scripts/bootstrap-env-local.sh --check`
on every PR to keep the bootstrap honest.

### Config source: local-file is the default; AppConfig is a documented opt-in

The committed `.env.local.example` default is `ALTER_CONFIG_SOURCE=local-file`.
Set `RUNTIME_MODE=mock` for mock runtime behavior. This is deliberate: making
AppConfig the committed local default would tax every developer with AWS
credentials just to start the stack.

**Running under real AWS AppConfig is an opt-in.** To prove a service runs
against real AppConfig (not LocalStack), set `ALTER_CONFIG_SOURCE=appconfig`
and provide the AppConfig identifiers the service reads from its own
environment. Every service reads the same canonical names:

- `APPCONFIG_APPLICATION_ID`, `APPCONFIG_ENVIRONMENT_ID`,
  `APPCONFIG_CONFIGURATION_PROFILE_ID`.

platform-api additionally accepts the legacy short forms
(`APPCONFIG_APP_ID`, `APPCONFIG_ENV_ID`, `APPCONFIG_PROFILE_ID`) as a
fallback; the long forms win when both are present. New configuration should
use the long forms everywhere.

Each service points at its own AppConfig application (e.g. `alterx-engine`
for model-gateway, `alterx-tool-gateway` for tool-gateway) in `ALTER_REGION`.
Under `appconfig`, the service also resolves its real secrets from AWS
Secrets Manager and its real SSM parameters, so the corresponding real
resources must exist. `ALTER_ENV=local` keeps the local secret namespace.

The reference values in `.env.local.example` point at the real AWS resource
names. audit-service and cost-ledger-service resolve their database secrets
from AWS Secrets Manager regardless of config source, and orchestration-service
reads `ALTER_ARTIFACTS_BUCKET_PARAM` eagerly at boot, so those resources must
exist even in mock mode. The resources the committed references name are:

- SSM parameters: `/alter/local/audit/archive-bucket`,
  `/alter/local/orchestration/artifacts-bucket`,
  `/alter/local/platform-api/system/actor-token-signing-key`
- Secrets Manager: `alter/local/audit-service/db-password`,
  `alter/local/audit-service/deletion-pseudonym-key`,
  `alter/local/audit-service/deletion-service-token`,
  `/alter/local/cost-ledger-service/database-credentials`,
  `/alter/local/cost-ledger-service/pseudonym-key`

`scripts/check-reference-resolution.sh` (see below) verifies every committed
reference resolves against real AWS; it needs credentials and is gated behind
`RUN_LIVE_REFERENCE_CHECK=1`.

**Deployed environments** set `ALTER_CONFIG_SOURCE=appconfig` everywhere.
`PLATFORM_API_CONFIG_SOURCE` remains a deprecated compatibility alias only;
new configuration must not use it.

## Start dependency stack

```bash
docker compose --env-file .env.local up -d --build --wait \
  engine-db ads-db cost-db redis localstack temporal tempo grafana
docker compose --env-file .env.local ps
```

Expected local endpoints:

- Engine PostgreSQL: `127.0.0.1:5433`, database `audit_db`, role
  `audit_service`
- ADS PostgreSQL: `127.0.0.1:5434`, database `ads_db`, role `ads_core`
- Cost PostgreSQL: `127.0.0.1:5435`, database `cost_db`, role
  `cost_ledger_service`
- LocalStack edge: `http://127.0.0.1:4566`
- Temporal gRPC: `127.0.0.1:7233`
- Temporal Web UI: `http://127.0.0.1:8233`
- Tempo OTLP/gRPC (trace ingest): `127.0.0.1:4317`
- Tempo OTLP/HTTP (trace ingest): `http://127.0.0.1:4318`
- Tempo query API / health: `http://127.0.0.1:3200/ready`
- Grafana UI (anonymous admin, local only): `http://127.0.0.1:3300`

LocalStack ready hook creates the audit database secret at
`alter/local/audit-service/db-password` from local runtime values and creates
`alter-local-cost-events` with its DLQ.
AWS SDK v3 reads `AWS_ENDPOINT_URL`, so all local AWS clients use LocalStack and
production adapter code needs no LocalStack-specific branch.

## Seed fixtures

Once the databases below are migrated, seed the fixtures the component probes
need. The script is idempotent, so re-run it freely:

```bash
set -a; . ./.env.local; set +a
sh scripts/seed-local.sh
```

It creates a tenant, a workspace and a user in `platform_db`, a workflow with a
compiled version in `orchestration_db`, and two agents in `intelligence_db` that
are identical in capability embedding and recorded verdict but differ by roughly
an order of magnitude in `latency_ms` and `token_count`. That last pair exists so
routing behaviour can be observed directly: anything scoring on cost or latency
separates them, anything scoring only on similarity and verdict cannot.

Identifiers are fixed rather than generated, so probes can reference them. Note
that `tenant_id` and `workspace_id` are bare `uuid` values in every database
while the API layer expects the `ten_` / `ws_` prefixed form -- prefix them when
calling an HTTP or gRPC surface.

## Run ADS Core

ADS Core owns its dedicated `pgvector` cluster; apply its migrations before
starting the HTTP and gRPC processes:

```bash
export ADS_LOCAL_SERVICE_TOKEN="$(openssl rand -hex 32)"
export INTERNAL_SERVICE_TOKEN_SHA256="$(printf %s "$ADS_LOCAL_SERVICE_TOKEN" | shasum -a 256 | awk '{print $1}')"
pnpm nx run ads-core:migrate
INTERNAL_SERVICE_TOKEN_SHA256="$INTERNAL_SERVICE_TOKEN_SHA256" \
  uv run --project apps/ads-core uvicorn src.main:app --app-dir apps/ads-core \
  --host 127.0.0.1 --port 8000
```

`MODEL_GATEWAY_GRPC_TARGET` must point at a running model gateway using a real
embedding provider before ingestion or retrieval can succeed. Do not replace it
with test-only embeddings for manual E2E checks.

## Run audit-service

Export local variables, build, and serve from host:

```bash
set -a
source .env.local
set +a
NODE_ENV=development pnpm nx run audit-service:serve
```

Startup runs Drizzle migrations against `audit_db`. In another terminal:

```bash
curl --fail --silent http://127.0.0.1:3000/health
# {"status":"ok","service":"audit-service"}
```

Verify migration and dedicated DB identity:

```bash
docker compose --env-file .env.local exec -T engine-db sh -c \
  'PGPASSWORD="$AUDIT_DB_PASSWORD" psql -U audit_service -d audit_db -Atc \
  "SELECT current_user, to_regclass('"'"'public.audit_events'"'"');"'
# audit_service|audit_events
```

## Run cost-ledger-service

cost-ledger-service owns its own `cost-db` cluster, started above. Its first
migration creates the `cost_ledger_provisioner` role with `BYPASSRLS`, which
needs superuser or `CREATEROLE` -- `cost-db`'s `POSTGRES_USER` is that
superuser via the official image's initdb, same as `platform-db`/`ads-db`/
`engine-db`. The LocalStack ready hook seeds both secrets the service needs:
`database_credentials`, containing the local `cost-db` connection string, and
`pseudonym_key`. Start the service from the same shared environment file used
by the dependency stack; startup applies the migrations automatically:

```bash
set -a
source .env.local
set +a
pnpm nx run cost-ledger-service:serve
```

In another terminal, verify both the HTTP service and the migrated database:

```bash
curl --fail --silent http://127.0.0.1:3022/health
# {"status":"ok","service":"cost-ledger-service"}
docker compose --env-file .env.local exec -T cost-db sh -c \
  'PGPASSWORD="$COST_DB_PASSWORD" psql -U cost_ledger_service -d cost_db -Atc \
  "SELECT rolname FROM pg_roles WHERE rolname = '"'"'cost_ledger_provisioner'"'"';"'
# cost_ledger_provisioner
```

## Run background-workers

Background-workers is a NestJS process that runs the Executor Temporal worker,
cost-events SQS consumer, canonical-events SQS consumer, and platform jobs
Temporal worker. It exposes only an HTTP health endpoint.

```bash
set -a
source .env.local
set +a
NODE_ENV=development pnpm nx run background-workers:serve
```

Requires the full dependency stack (Temporal, LocalStack/SQS, Redis) plus
running instances of orchestration-service, cost-ledger-service, and
platform-api. Without Temporal and SQS the workers will fail to start.

## Run eval-service

eval-service is a FastAPI service (Python) providing evaluation, golden-set,
and red-team capabilities. It has both HTTP and gRPC surfaces.

```bash
pnpm nx run eval-service:migrate
NODE_ENV=development pnpm nx run eval-service:serve
```

Health check (HTTP, default port from uvicorn is 8000):
```bash
curl --fail --silent http://127.0.0.1:8000/health
```

eval-service has the most cross-service dependencies of any service: it needs
Postgres (multiple databases via its config defaults), model-gateway,
verification-service, tool-gateway, memory-service, intelligence-service,
audit-service, and Auth0 M2M credentials. It effectively cannot run without
most of the platform already started. Set `INTERNAL_SERVICE_TOKEN` and its
corresponding `INTERNAL_SERVICE_TOKEN_SHA256` consistently with memory-service.

## Run intelligence-service

intelligence-service is a FastAPI service (Python) providing planner,
capability resolution, and agent binding. It has HTTP surfaces (planner,
problem-understanding, selection-binding, performance) and a gRPC surface
(capability_resolver).

Apply migrations and start:
```bash
pnpm nx run intelligence-service:migrate
NODE_ENV=development pnpm nx run intelligence-service:serve
```

Health check (HTTP, default port 8000):
```bash
curl --fail --silent http://127.0.0.1:8000/health
```

Depends on engine-db (Postgres, port 5433 â€” `intelligence_db`), model-gateway
gRPC (default `localhost:50051`), ads-core's ADSQ gRPC (default
`localhost:50050`), and memory-service HTTP (default
`http://localhost:8002`). Auth0 M2M credentials
are optional for local (`AUTH0_M2M_*` can be empty when `ALTER_ENV=local`).

## Run memory-service

memory-service is a FastAPI service (Python) providing memory learning,
policy store, and drift detection. It exposes three HTTP routers:
`memory_learning`, `policy_store`, `drift`.

Apply migrations and start:
```bash
pnpm nx run memory-service:migrate
UVICORN_PORT=8002 NODE_ENV=development pnpm nx run memory-service:serve
```

Health check (HTTP, port 8002):
```bash
curl --fail --silent http://127.0.0.1:8002/health
```

Depends on engine-db (Postgres, port 5433 â€” `policy_db`), orchestration-service
HTTP (`ORCHESTRATION_SERVICE_BASE_URL`, `http://127.0.0.1:3010` for this stack;
the service's own default is 3000, which is platform-web), intelligence-service HTTP, ads-core HTTP,
and cost-ledger-service HTTP. Protected by `INTERNAL_SERVICE_TOKEN_SHA256` â€”
export this consistently with `INTERNAL_SERVICE_TOKEN` used by calling services.

The serve target runs `uvicorn`, which reads `UVICORN_PORT` and ignores `PORT`: started
with `PORT=8002` the service comes up on uvicorn's default 8000 instead, and every
caller configured for 8002 fails to reach it.

Set `POLICY_DB_SYSTEM_URL_SYNC` as well as `POLICY_DB_URL_SYNC`. memory-service connects
a second time as `policy_system_writer` for the rows its RLS policies reserve to that
identity, which is every agent drift write and every global-scope policy or memory
write. Its built-in default for that URL carries no password, so leaving it unset fails
at call time rather than at boot.

## Run model-gateway

model-gateway is a NestJS service providing the only path to LLM providers
(Bedrock primary, Anthropic/OpenAI optional failovers) plus a semantic cache.
It has both HTTP and gRPC surfaces.

```bash
set -a
source .env.local
set +a
NODE_ENV=development pnpm nx run model-gateway:serve
```

Health check (HTTP):
```bash
curl --fail --silent http://127.0.0.1:$PORT/health
```

Requires Redis (port 6379, for cache), Presidio analyzer/anonymizer
(ports 5001/5002, for PII redaction), and LocalStack (port 4566, for
AppConfig and SecretsManager). With `ALTER_CONFIG_SOURCE=mock` and
`ALTER_ENV=local`, model providers and AWS services are replaced by mock
implementations â€” this is the recommended local mode.

**Mock mode does not cover authentication.** `M2mValidator` requires
`AUTH0_DOMAIN` and `API_AUDIENCE` unconditionally and throws
`Session Gateway M2M configuration is incomplete` at boot without them, so the
service will not start on mock settings alone. Point it at the local issuer
described next.

## Local M2M authentication

Every gRPC and internal HTTP surface sits behind `ServiceAuthGuard`, which
validates a real Auth0 M2M JWT. There is no local bypass. Calling a service
without one returns `Internal service credential is invalid`, which reads like a
broken service rather than a missing credential.

`scripts/local-mock-auth0/server.js` issues tokens the validator accepts. Start
it before any service that needs authentication:

```bash
node scripts/local-mock-auth0/server.js &
```

It serves `/.well-known/jwks.json` and `POST /oauth/token` on port 4999, signing
RS256 tokens as issuer `alterx-local-m2m.test`. Export these alongside
`.env.local`:

```bash
export AUTH0_DOMAIN=alterx-local-m2m.test
export AUTH0_JWKS_URL=http://127.0.0.1:4999/.well-known/jwks.json
export API_AUDIENCE=https://engine.alter.local
```

To call a service, mint a token:

```bash
TOKEN=$(sh scripts/local-m2m-token.sh)
grpcurl -H "authorization: Bearer $TOKEN" ...
```

Two notes for gRPC surfaces. They do not enable reflection, so pass the proto
explicitly: `-import-path packages/contracts/proto -proto
alter/<svc>/v1/<svc>.proto`. And if you run `grpcurl` from a container while the
service runs natively on the host, reach it at `host.docker.internal` rather
than `127.0.0.1` -- `--network host` places the container in the Docker VM's
network namespace, which is where the compose containers live but not where a
locally started service does.

**A service that calls another service needs a second, separate set of
variables.** The block above lets a service *validate an incoming* token.
orchestration-service's node executor also acts as a *client* -- e.g.
`LlmTaskHandler` streaming to model-gateway through `ModelGatewayClient` --
and that path goes through `Auth0M2mTokenProvider`
(`packages/auth/session-gateway`), which is configured separately and fails
at call time, not at boot:

```
Missing required Auth0 M2M configuration: AUTH0_M2M_TOKEN_URL
```

The same local-mock-auth0 server issues these tokens too; any non-empty
client id/secret is accepted locally:

```bash
export AUTH0_M2M_TOKEN_URL=http://127.0.0.1:4999/oauth/token
export AUTH0_M2M_AUDIENCE=https://engine.alter.local
export AUTH0_M2M_CLIENT_ID=local-dev-client
export AUTH0_M2M_CLIENT_SECRET=local-dev-secret
```

## Run orchestration-service

orchestration-service is the Engine's largest NestJS service. It hosts 8
separate gRPC microservices (conversation, compiler, deploy-ctl, registry,
nodeexec, blackboard, recovery, runs, artifact-content) plus an HTTP surface,
all in one process. It starts with OpenTelemetry tracing preloaded.

```bash
set -a
source .env.local
set +a
NODE_ENV=development pnpm nx run orchestration-service:serve
```

Health check (HTTP):
```bash
curl --fail --silent http://127.0.0.1:$PORT/health
```

Requires Redis (port 6379, for Blackboard cache), Postgres (for conversation
state via Drizzle), model-gateway gRPC (port 50051), tool-gateway gRPC,
sandbox-service gRPC, verification-service gRPC, memory-service HTTP, and
intelligence-service/planner HTTP. Has drizzle migrations under
`apps/orchestration-service/drizzle/`. Tagged `security-critical`.

`.env.local.example` sets `CAPABILITY_RESOLVER_ADDRESS` and
`ARTIFACT_CONTENT_GRPC_BIND_ADDRESS` explicitly -- both of their code
defaults collide with something else (`EVAL_SERVICE_GRPC_TARGET` and
intelligence-service's own gRPC bind, respectively). Do not unset them.

### Actor tokens, when the caller is platform-api

Every Engine call platform-api makes carries two tokens: an Auth0 M2M token for
the service, and an *actor* (delegation) token carrying the end user. Only the
first comes from Auth0. Actor tokens are minted by platform-api's own identity
broker, signed with `ACTOR_TOKEN_SIGNING_KEY_REF`, and the matching public key is
served at platform-api's `/.well-known/actor-jwks.json`.

So `ACTOR_TOKEN_JWKS_URL` must point at **platform-api**, not at the mock Auth0
server -- that server mints an ephemeral keypair at startup for M2M tokens and
never sees the actor-token key, so no token it publishes can validate one.
`ACTOR_TOKEN_ISSUER` and `ACTOR_TOKEN_AUDIENCE` must equal the constants
platform-api stamps (`alter-platform-api.identity-broker` and `alter-engine`,
in `apps/platform-api/src/identity-broker/identity-broker.service.ts`). Any of
the three disagreeing fails every Engine-proxied route with
`AUTH_INVALID_ACTOR_TOKEN`, which platform-api reports to the browser as a 502.
`.env.local.example` carried placeholder values for all three until Batch 7 ran
platform-api against this stack for the first time.

## Run platform-api

platform-api is the Platform's NestJS BFF â€” the edge service handling
identity (Auth0/Google), signup, billing, marketplace, integrations,
env vars, credentials, registry, publisher, entitlements, and admin tenants.
It starts with OpenTelemetry tracing preloaded.

Migrate the database first, then serve:
```bash
pnpm --filter @alterx/platform-api db:migrate
NODE_ENV=development pnpm nx run platform-api:serve
```

`db:migrate` applies **two** schemas: the drizzle-generated platform schema in
`src/db/migrations`, then the hand-written marketplace schema in
`src/db/marketplace-migrations` (the marketplace, publisher & payout, tool
registry and marketplace-search tables). The second set runs against
`MARKETPLACE_DATABASE_URL`, which points at the same `platform_db` by default
but is its own variable and may point elsewhere.

Until they were composed, nothing outside the integration specs applied the
marketplace set, so `/api/v1/registry/tools` and every marketplace, publisher
and search route answered 500 on a missing relation (issue #171). To run or
reverse just that set:

```bash
pnpm --filter @alterx/platform-api db:migrate:marketplace
pnpm --filter @alterx/platform-api db:rollback:marketplace     # all of it
pnpm --filter @alterx/platform-api db:rollback:marketplace 1   # the last one
```

Both are idempotent: applied migrations are recorded in a
`marketplace_migrations` table, so re-running applies nothing.

Health check (HTTP, default port 3000):
```bash
curl --fail --silent http://127.0.0.1:3000/health
```

`PORT` moves it if 3000 is taken. platform-web's dev proxy sends `/api` to
3000 as well, so move both together:
`PORT=3020 ... platform-api:serve` and
`PLATFORM_API_PROXY_TARGET=http://127.0.0.1:3020 ... platform-web:serve`.

Eleven Engine-client variables are validated at boot and are not in
`.env.local.example`; without them the process exits with
`Invalid Engine client environment`. `ENGINE_BASE_URL` is orchestration-service
(`http://127.0.0.1:3010` for this stack), `ADS_CORE_BASE_URL`,
`COST_LEDGER_BASE_URL` and `AUDIT_SERVICE_BASE_URL` are their own services, the
four `ENGINE_M2M_*` values mirror the `AUTH0_M2M_*` block, and the `*_TOKEN_REF`
entries take `env:VARNAME` form (`env:INTERNAL_SERVICE_TOKEN` locally). Two more
are validated when their module is constructed rather than by the schema, so
they surface one at a time:
`CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN_REF` and
`NOTIFICATION_DIGEST_SERVICE_TOKEN_REF`.

platform-api also needs the outbound `AUTH0_M2M_*` block itself. Without it every
Engine-proxied route answers 502 `UPSTREAM_SERVICE_ERROR` -- which names the one
component that is not at fault; the real cause is now logged by `EngineClient`.

Requires platform-db (Postgres, port 5432). `IDENTITY_PROVIDER` and
`EMAIL_PROVIDER` both default to `mock` in code
(`apps/platform-api/src/identity/identity.module.ts`,
`packages/adapters/src/ses/resolve-email-provider.ts`) â€” leave them unset
and Auth0/Google OAuth and SES are already replaced by mock
implementations, no `.env.local` entry needed. AppConfig is replaced by
`local-file`, which platform-api reads from `PLATFORM_API_CONFIG_SOURCE` --
the scoped variable, set in `.env.local.example`. The shared
`ALTER_CONFIG_SOURCE=mock` there is for the Engine services and is not a value
platform-api accepts; an `.env.local` predating that entry fails every
platform-api invocation, `db:migrate` included, with
`Invalid platform-api environment: ALTER_CONFIG_SOURCE`.
Marketplace still needs a real Postgres-backed `MARKETPLACE_DATABASE_URL`
for entitlement and credential-guard specs.

## Run platform-web

platform-web is the Platform's frontend â€” a React SPA built with Vite.
It has no server-side runtime; all API calls go to platform-api or proxied
Engine services.

```bash
NODE_ENV=development pnpm nx run platform-web:serve
```

Vite dev server runs on port 5173 by default:
```bash
curl --fail --silent http://127.0.0.1:5173/
```

Set `VITE_API_MODE=live` to talk to platform-api at all; the default build is
mock end to end. `PLATFORM_API_PROXY_TARGET` overrides where `/api` is proxied
when platform-api is not on 3000.

Requires platform-api (and/or Engine services) to be running for any
functional use beyond the static UI shell. Note that live mode does not make the
whole UI live: `node scripts/batch7-api-surface.mjs` lists which API methods have
a live path and which are mock in every mode. Build for production with
`pnpm nx build platform-web` and preview with `pnpm nx preview platform-web`.

## Run provisioning-service

provisioning-service is a NestJS service handling resource provisioning
with both HTTP and gRPC surfaces.

```bash
set -a
source .env.local
set +a
NODE_ENV=development pnpm nx run provisioning-service:serve
```

Health check (HTTP, default port 3000):
```bash
curl --fail --silent http://127.0.0.1:3000/health
```

Requires LocalStack (port 4566, for SecretsManager to read E2B API key
references). With `ALTER_CONFIG_SOURCE=mock` and `ALTER_ENV=local`, AWS
SecretsManager and the E2b sandbox provider are replaced by mock
implementations. Tagged `security-critical`.

## Run sandbox-service

sandbox-service is a NestJS service managing code execution sandboxes (E2b
primary) and browser automation (Browserbase). It has both HTTP and gRPC
surfaces.

```bash
set -a
source .env.local
set +a
NODE_ENV=development pnpm nx run sandbox-service:serve
```

Health check (HTTP):
```bash
curl --fail --silent http://127.0.0.1:$PORT/health
```

Requires LocalStack (port 4566, for SecretsManager and AppConfig), and the
artifact-content gRPC service from orchestration-service (port 50061). With
`ALTER_CONFIG_SOURCE=mock` and `ALTER_ENV=local`, sandbox providers (E2b,
AgentCore) and Browserbase are replaced by mock implementations.

## Run tool-gateway

tool-gateway is a NestJS service providing the only path to external tools
(search via Tavily, database, browser automation, web fetch with SSRF
guarding). It has both HTTP and gRPC surfaces.

```bash
set -a
source .env.local
set +a
NODE_ENV=development pnpm nx run tool-gateway:serve
```

Health check (HTTP):
```bash
curl --fail --silent http://127.0.0.1:$PORT/health
```

Requires Redis (port 6379, for cache), LocalStack (port 4566, for
SecretsManager, AppConfig, SQS), and audit-service gRPC for tool-call
audit logging. With `ALTER_CONFIG_SOURCE=mock`, external tool providers
(Tavily, Browserbase) are replaced by mock implementations.

## Run verification-service

verification-service is a FastAPI service (Python) providing quality gates
and recovery orchestration. It has an HTTP surface (quality evaluation)
and a separate gRPC server (severity assessment).

Start the HTTP server:
```bash
NODE_ENV=development pnpm nx run verification-service:serve
```

Start the gRPC server (separate process, in another terminal):
```bash
NODE_ENV=development pnpm nx run verification-service:serve-grpc
```

Health check (HTTP, default port 8000):
```bash
curl --fail --silent http://127.0.0.1:8000/health
```

intelligence-service also defaults to uvicorn's port 8000, so give one of the two
an explicit `UVICORN_PORT` when both are running.

Minimal external dependencies: requires model-gateway gRPC (port 50051)
and, optionally, memory-service HTTP for quality-threshold policy lookups.
Both processes call model-gateway as a client, so both need the outbound
`AUTH0_M2M_*` credentials, not just the inbound `AUTH0_*` ones -- without them
every content-bearing node type fails its gate with `FAST classifier call
failed` while the deterministic node types keep passing.
Protected by `INTERNAL_SERVICE_TOKEN_SHA256`. It owns no database and has no
migrations, but the gRPC server still requires `ORCHESTRATION_DATABASE_URL`: it
writes its verdicts into orchestration_db's `verification_results`, which that
service owns.

## Provider choices

- Secrets use real `AwsSecretsManagerProvider` against LocalStack through
  standard AWS SDK endpoint configuration. LocalStack is pinned to final
  token-free Community release `4.14.0`; newer releases require an account and
  conflict with this stack's zero-account contract.
- Temporal container is official `temporalio/temporal` CLI dev server with
  bundled Web UI. It is intentionally disposable; production namespace,
  retention, history rollover, and versioned-worker rollout requirements are
  in [`runbooks/temporal-production.md`](runbooks/temporal-production.md).
- Tracing is a real `grafana/tempo` OTLP receiver (gRPC 4317 / HTTP 4318,
  local disk storage) with `grafana/grafana` wired to it as a datasource for
  browsing traces -- not a passive console-only collector. Shared mock
  `ObservabilityProvider` (`createMockObservabilityProvider()`) is available
  in `packages/shared-clients` for apps that wire it. No app currently sends
  it real traces, including `audit-service`; app-level observability
  integration remains future per-app work. No fake SaaS credential path is
  added.
- Shared mock providers remain available for services without local container
  bindings.

## Reference resolution check

`scripts/check-reference-resolution.sh` lists the real AWS SSM parameters and
Secrets Manager secrets (names only, never values) and fails if any committed
reference in `.env.local.example` does not exist. It needs live AWS
credentials, which CI does not have, so it is gated behind
`RUN_LIVE_REFERENCE_CHECK=1` (the same pattern as the live Titan embedding
test) and is run manually:

```bash
RUN_LIVE_REFERENCE_CHECK=1 scripts/check-reference-resolution.sh
```

It is proven to fail: pointing any committed reference at a nonexistent name
makes it exit non-zero naming the offending variable. Run it after changing a
committed reference value, and before relying on the AppConfig path from
committed configuration alone.

## Stop

```bash
docker compose --env-file .env.local down
```

Add `--volumes` only when intentionally deleting local Engine DB data. It also
deletes Platform DB data if that service has been started from this Compose
project.

## Known gaps

No live AWS, Temporal Cloud, Grafana Cloud, Sentry, or LocalStack accounts are
used. Token-free LocalStack `4.14.0` no longer receives upstream updates and
must be reviewed before any production-like use. Tempo/Grafana are real and
running, but no app sends them real traces yet; app-level observability
wiring remains a future service integration task.

`presidio-analyzer`/`presidio-anonymizer` containers (PII redaction for
`model-gateway`, ports 5001/5002) are not started by the dependency stack's
`docker compose` command above â€” model-gateway's mock mode works without them,
but real Presidio requires manually starting those containers.

`background-workers` and `eval-service` effectively cannot function without
most of the platform already running (Temporal, SQS, 10+ downstream services
respectively) â€” they are documented here for completeness but are not
independently runnable in isolation.
