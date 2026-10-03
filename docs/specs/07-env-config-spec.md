# Alter — Environment & Configuration Specification

**Version:** 1.0
**Date:** 2026-07-21
**Status:** Approved baseline.

---

## 1. Environments

**Permanent:** `dev` → `staging` → `prod`. No fourth permanent environment in v1.

**Ephemeral:**

- Platform frontend preview per PR (Vercel previews)
- Project Mode generated-app preview per build/PR
- Temporary backend integration stack per PR (disposable CI environment: containers + isolated DB namespace + LocalStack) — Engine changes get contract + integration tests here before staging
- Isolated test database namespaces where required

Promotion path: PR ephemeral checks → `dev` → `staging` (release candidate + eval golden-set gate) → `prod` (canary via Workflow Lifecycle).

---

## 2. AWS Account Structure (Organizations + Control Tower, day one)

| Account | Purpose |
|---|---|
| `alter-management` | Organizations, billing, Control Tower. **No application workloads.** |
| `alter-log-archive` | Central CloudTrail, AWS Config, immutable security logs |
| `alter-security` | Security tooling, GuardDuty/Security Hub admin, audit access, break-glass |
| `alter-shared-services` | CI/CD support, shared DNS, container registry (ECR), common networking |
| `alter-dev` | dev workloads |
| `alter-staging` | staging workloads |
| `alter-prod` | prod workloads |
| `alter-sandbox-exec` | High-risk browser + code-execution workloads, external sandbox-provider integration. Separate blast radius from control plane. |

Rules: Terraform from day one; Service Control Policies; IAM Identity Center for humans; cross-account deployment roles for CI; separate KMS keys per environment; separate budgets + alerts per account; no shared production credentials. Region: `ap-south-1`, Multi-AZ.

---

## 3. Configuration Hierarchy

| Layer | Holds | Not for |
|---|---|---|
| **Repository** | Typed config schemas, safe defaults, service manifests, provider capability declarations, local dev config, environment config *templates* | Operational secrets, frequently changed prod settings |
| **AWS AppConfig** | Runtime feature flags, provider activation, model-routing defaults, recovery thresholds, kill switches, dynamic rollout config — validated deploys + rollback | Secrets |
| **SSM Parameter Store** | Non-secret env parameters: service endpoints, resource identifiers, region settings, low-frequency operational config | Credentials |
| **Secrets Manager** | DB credentials, provider API credentials, signing keys, OAuth client secrets, tenant integration credentials, encryption material | Anything non-secret |
| **policy_db** | Business policies: routing weights, thresholds, recovery preferences, tenant restrictions, versioned history | Infrastructure config |

**Provider selection is not static YAML.** Resolution chain:

```
system-supported providers
→ environment default
→ workload policy
→ tenant override (where permitted)
→ runtime health/fallback decision
```

Every layer resolves through Alter-owned adapter interfaces; config only names adapters that exist in the capability registry.

---

## 4. Secrets

**Naming:**

```
/alter/{env}/{service}/system/{secret_name}
/alter/{env}/tenant/{tenant_id}/integration/{integration_id}/{secret_name}
```

Examples: `/alter/prod/model-gateway/system/bedrock-role`, `/alter/prod/tenant/ten_x/integration/shopify_x/access-token`.

Rules:

- Secret *names* contain identifiers only, never values
- Tags: owner, environment, data class, rotation policy
- Separate KMS key policy per environment; prod secrets unreachable from dev/staging identities
- Applications fetch only through provider-neutral `SecretsProvider`; no SDK calls in business code
- Database rows store credential **reference IDs** only (see Data Model)

**Rotation:** 90-day default; shorter for high-privilege internal credentials; immediate on suspected exposure; provider-managed rotation where available; OAuth per provider lifecycle; signing keys support overlapping versions during rotation.

---

## 5. Per-Service Environment Variables (bootstrap set)

Only bootstrap identity + pointers live in process env. Everything else resolves at runtime from AppConfig/SSM/Secrets via adapters. Every service validates its env schema on startup and crashes loudly on missing/invalid values.

**Common to all services:**

```
ALTER_ENV                dev | staging | prod | local
ALTER_SERVICE_NAME
ALTER_REGION             ap-south-1
ALTER_CONFIG_SOURCE      appconfig | local-file
APPCONFIG_APP_ID / APPCONFIG_ENV_ID / APPCONFIG_PROFILE_ID
OTEL_EXPORTER_OTLP_ENDPOINT
LOG_LEVEL
```

**platform-api:** `DATABASE_SECRET_REF (platform_db)`, `IDP_ISSUER_URL`, `IDP_AUDIENCE`, `ACTOR_TOKEN_SIGNING_KEY_REF`, `REDIS_ENDPOINT_PARAM`
**orchestration-service:** `DATABASE_SECRET_REF (orchestration_db)`, `TEMPORAL_ADDRESS_PARAM`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY_REF`, `EVENTBUS_NAME_PARAM`, `REDIS_ENDPOINT_PARAM`

D20 node override advice also accepts `NODE_OVERRIDE_ADVISORY_THRESHOLDS`, a
validated JSON object read at startup. Defaults are
`{"costIncreaseRatio":0.25,"costIncreaseMinor":500,"latencyMultiplier":2}`;
the cost warning requires both the ratio and the absolute increase in INR paise.
Unknown fields, negative cost thresholds and latency multipliers below one fail
startup. Provider critique uses the existing `PLANNER_BASE_URL` intelligence
endpoint and `INTERNAL_SERVICE_TOKEN`; D4 prices use the existing model policy
and Cost Ledger adapters. Workspace/workflow approval rules remain authoritative.
**event-trigger-gateway:** `DATABASE_SECRET_REF (orchestration_db triggers scope)`, `WEBHOOK_SIGNING_SECRET_REFS_PREFIX`, `EVENTBUS_NAME_PARAM`, `SQS_FIFO_URL_PARAM`, `TEMPORAL_ADDRESS_PARAM`
**intelligence-service (Python):** `DATABASE_SECRET_REF (intelligence_db)`, `MODEL_GATEWAY_GRPC_ADDR`, `ADSQ_GRPC_ADDR`
**model-gateway (+cache):** `BEDROCK_ROLE_REF`, `ANTHROPIC_API_KEY_REF`, `OPENAI_API_KEY_REF`, `PRESIDIO_ENDPOINT_PARAM`, `REDIS_ENDPOINT_PARAM`, `DATABASE_SECRET_REF (cache vectors)`, `COST_QUEUE_URL_PARAM`
**tool-gateway:** `SECRETSPROVIDER_SCOPE_PREFIX`, `TAVILY_API_KEY_REF`, `SSRF_POLICY_PROFILE_ID`, `COST_QUEUE_URL_PARAM`
**sandbox-service:** `E2B_API_KEY_REF`, `BROWSERBASE_API_KEY_REF`, `ARTIFACT_BUCKET_PARAM`, `COST_QUEUE_URL_PARAM` (deployed in `alter-sandbox-exec` account)
**verification-service:** `MODEL_GATEWAY_GRPC_ADDR`, `DATABASE_SECRET_REF (orchestration_db verification scope)`
**memory-policy-service (+drift):** `DATABASE_SECRET_REF (policy_db)`, `ADS_INGEST_GRPC_ADDR`, `MODEL_GATEWAY_GRPC_ADDR`
**cost-ledger-service:** `DATABASE_SECRET_REF (cost_db)`, `COST_QUEUE_URL_PARAM`
**eval-service:** `DATABASE_SECRET_REF (eval_db)`, `LANGFUSE_KEY_REF`, `MODEL_GATEWAY_GRPC_ADDR`
**audit-service:** `DATABASE_SECRET_REF (audit_db)`, `AUDIT_ARCHIVE_BUCKET_PARAM`
**ads-core:** `DATABASE_SECRET_REF (ads cluster)`, `ADS_BUCKET_PARAM`, `EMBEDDING_PROVIDER_CONFIG_REF`, `INGEST_QUEUE_URL_PARAM`
**platform-web (Next.js):** `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_ENV`, `AUTH0_DOMAIN/CLIENT_ID` (public), server-side `AUTH0_CLIENT_SECRET_REF`

---

## 6. Local Development

Docker Compose stack: PostgreSQL + pgvector, Redis/Valkey, LocalStack (SQS, EventBridge, S3, Secrets Manager, SSM), Temporal dev server, local object-storage adapter where needed, OpenTelemetry collector, mail/webhook test receiver.

Mock adapters (same Alter interfaces as production): Bedrock, Anthropic, OpenAI, Auth0, E2B, Browserbase, Tavily, Vercel, GitHub, ADS.

Rules: `.env.local` per service, never committed, validated on startup; safe synthetic seed data; repeatable reset scripts; deterministic provider mocks; local contract tests run against the identical interfaces used in production.

---

## 7. GPU

No dedicated GPU in default v1 control plane (managed model/embedding APIs; orchestration is CPU). Capability preserved via `GPUComputeProvider` (ECS/EKS GPU, SageMaker, RunPod, Modal, customer-cloud adapters) for later: self-hosted models, fine-tuning, vision processing, heavy eval, GPU sandboxes. Activation decision, not product restriction.

---

## 8. Private Client-System Connectivity (day-one design)

Managed clients have private DBs/ERPs/APIs that must never be publicly exposed.

Preference order:

```
customer-deployed outbound connector
→ AWS PrivateLink
→ VPC peering
→ site-to-site VPN
→ tightly controlled public endpoint (fallback)
```

IP allowlisting only as controlled fallback; SSH tunnels prohibited as permanent production design.

Requirements: Alter workloads in private subnets; VPC endpoints for AWS services; no direct public database connections; per-tenant network policy; short-lived DB credentials; read-only by default; full audit logs; connection health monitoring; tenant-specific kill switch.

Interface: `NetworkConnectivityProvider` → PrivateLink / VPCPeering / SiteToSiteVPN / OutboundConnector / CustomerCloud adapters.

---

## 9. Plug-and-Play Interfaces (config domain)

```
ConfigProvider            SecretsProvider        IdentityProvider
RelationalDatabaseProvider VectorStoreProvider   CacheProvider
QueueProvider             EventBusProvider       ObjectStorageProvider
DurableExecutionProvider  ComputeProvider        GPUComputeProvider
NetworkConnectivityProvider ObservabilityProvider
```

Rules (same law as everywhere): vendor SDKs only inside adapters; canonical Alter config schema; provider selection through validated configuration; contract tests + mock adapter per category; no vendor resource ID as Alter domain identifier; migration + rollback procedures; capability registry blocks unsupported substitutions; core logic unchanged on provider swap.

---

## 10. Summary of Locked Decisions

Three permanent environments + three ephemeral preview classes; eight-account Control Tower structure; Terraform-managed everything; AppConfig for dynamic config, SSM for parameters, Secrets Manager for credentials, policy_db for business behavior; hierarchical provider resolution with tenant overrides; 90-day rotation default; full local Docker + mock-provider parity; GPU-ready without GPU dependency; private client connectivity supported from day one; all infrastructure replaceable behind Alter-owned adapters.


## D21 registry package scanner

`REGISTRY_SCAN_PROVIDER=osv` is the production default. The Node image includes
OSV-Scanner v2.6.0 at `/usr/local/bin/osv-scanner`; `OSV_SCANNER_EXECUTABLE` can
select that executable explicitly. `REGISTRY_PACKAGE_BUCKET` binds the
version-enabled package bucket. The existing AWS region and service identity
provide object-version reads. Missing bindings produce nonclean scan reports;
there is no production mock fallback. See [package-scanning.md](../package-scanning.md)
for the exact tenant/version object prefix, supported input formats, limits,
publication states and first-version staff review.
