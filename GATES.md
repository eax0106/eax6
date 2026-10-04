# Gates: D22 configured subscription checkout and free-only marketplace (C122)

OWNS: apps/platform-api/project.json, apps/platform-api/src/publisher/**, apps/platform-api/src/billing/**, apps/platform-api/src/admin-tenants/admin-tenants.module.spec.ts, apps/platform-api/src/health/health.controller.spec.ts, apps/platform-api/src/engine/billing-policy-client.ts, apps/platform-api/src/engine/billing-policy.integration.spec.ts, apps/platform-api/src/entitlements/**, apps/platform-api/src/admin-policy/**, apps/platform-api/src/marketplace/**, apps/platform-api/src/signup/**, apps/platform-api/src/identity/membership-identity-resolver.ts, apps/platform-api/src/identity/identity.module.ts, apps/platform-api/src/config/**, apps/platform-api/src/db/**, apps/platform-api/src/deletion/**, apps/orchestration-service/src/runs/**, apps/orchestration-service/src/billing/**, apps/orchestration-service/src/deletion/**, apps/orchestration-service/src/run-retention/**, apps/orchestration-service/src/run-launcher.module.ts, apps/orchestration-service/src/connections/**, apps/orchestration-service/src/trigger-registry/**, apps/orchestration-service/src/ingress.module.ts, apps/orchestration-service/src/operations.module.ts, apps/orchestration-service/src/config/**, apps/orchestration-service/src/health/health.controller.spec.ts, apps/orchestration-service/src/orchestration-infrastructure.module.ts, apps/orchestration-service/drizzle/**, apps/orchestration-service/src/identity-tenant-gateway/**, packages/shared-clients/src/**, packages/adapters/src/razorpay/**, packages/adapters/src/http/**, packages/contracts/src/**, packages/deletion-registry/src/**, apps/platform-web/src/api/**, apps/platform-web/src/features/money/**, apps/platform-web/src/features/marketplace/**, apps/platform-web/src/features/seller/**, apps/platform-web/src/app/router.tsx, tests/integration/rbac/**, scripts/gates/baseline.json, deploy/ec2/**, .env.local.example, docs/billing.md, docs/work-queue.md

Scope: D22 uses Razorpay Subscriptions for hosted checkout, signed recurring lifecycle and cancellation; configured exclusive-GST prices add 18 percent at checkout and collect GSTIN. Prices and credit quantities remain owner configuration, with unconfigured paid plans unavailable. Free-tier verified-email and daily-run limits apply at central admission. V1 marketplace has no paid installation or payout path. Gateway fees are absorbed. No live payment, vendor account or deployment is required for engineering proof.

- [ ] G1: Plan definitions persist validated price, provider plan mapping, included credits, extra-credit price, credits per verified run and daily cap; unconfigured paid prices cannot initiate payment
  CHECK: node .unlazy/verify-config.mjs
  EXPECT: payments-config-passed
  EVIDENCE: pending

- [ ] G2: Razorpay creates a bounded hosted subscription checkout with configured tax-inclusive provider amount and GSTIN; it never accepts card data, arbitrary provider plans or an unsafe checkout URL
  CHECK: node .unlazy/verify-checkout.mjs
  EXPECT: payments-checkout-passed
  EVIDENCE: pending

- [ ] G3: Authenticated subscription create/change/cancel routes preserve caller scope, idempotency and current versions; creation does not grant paid entitlement before activation
  CHECK: node .unlazy/verify-http.mjs
  EXPECT: payments-http-passed
  EVIDENCE: pending

- [ ] G4: Signed duplicate, stale and foreign webhook events cannot change unrelated subscriptions; provider activation, charge, failure and cancellation map to configured internal plans and durable audited lifecycle
  CHECK: node .unlazy/verify-webhooks.mjs
  EXPECT: payments-webhooks-passed
  EVIDENCE: pending

- [ ] G5: Real PostgreSQL central run admission enforces configured daily cap atomically across manual, triggered and replay starts; rollback leaves no run or debit, verified-run credits settle once and other tenants remain unaffected
  CHECK: node .unlazy/verify-usage.mjs
  EXPECT: payments-usage-passed
  EVIDENCE: pending

- [ ] G6: V1 free-only marketplace refuses paid publication and install on backend and hides paid checkout, payout and KYC flows; actual free listing install remains functional
  CHECK: node .unlazy/verify-marketplace.mjs
  EXPECT: payments-marketplace-passed
  EVIDENCE: pending

- [ ] G7: Live and mock billing render configured base price, 18 percent GST and total, GSTIN validation, hosted checkout, subscription state and cancellation; errors and unavailable configuration remain visible
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: payments-web-passed
  EVIDENCE: pending

- [ ] G8: Meaningful fault controls fail and pass restored code; full affected suites, production configuration, migration rollback, erasure, architecture, RBAC, coverage and normalized AST checks pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: payments-final-passed
  EVIDENCE: pending
