# Gates: D22 configured subscription checkout and free-only marketplace (C122)

OWNS: scripts/bootstrap-env-local.sh, apps/orchestration-service/src/database/migration-files.spec.ts, apps/platform-api/project.json, apps/platform-api/src/publisher/**, apps/platform-api/src/billing/**, apps/platform-api/src/admin-tenants/admin-tenants.module.spec.ts, apps/platform-api/src/health/health.controller.spec.ts, apps/platform-api/src/engine/billing-policy-client.ts, apps/platform-api/src/engine/billing-policy.integration.spec.ts, apps/platform-api/src/entitlements/**, apps/platform-api/src/admin-policy/**, apps/platform-api/src/marketplace/**, apps/platform-api/src/marketplace-governance/tool-version-review.integration.spec.ts, apps/platform-api/src/signup/**, apps/platform-api/src/identity/membership-identity-resolver.ts, apps/platform-api/src/identity/identity.module.ts, apps/platform-api/src/config/**, apps/platform-api/src/db/**, apps/platform-api/src/deletion/**, apps/orchestration-service/src/runs/**, apps/orchestration-service/src/billing/**, apps/orchestration-service/src/registry/finalize-replay.integration.spec.ts, apps/orchestration-service/src/deletion/**, apps/orchestration-service/src/run-retention/**, apps/orchestration-service/src/run-launcher.module.ts, apps/orchestration-service/src/connections/**, apps/orchestration-service/src/trigger-registry/**, apps/orchestration-service/src/ingress.module.ts, apps/orchestration-service/src/operations.module.ts, apps/orchestration-service/src/config/**, apps/orchestration-service/src/health/health.controller.spec.ts, apps/orchestration-service/src/orchestration-infrastructure.module.ts, apps/orchestration-service/drizzle/**, apps/orchestration-service/src/identity-tenant-gateway/**, packages/shared-clients/src/**, packages/adapters/src/razorpay/**, packages/adapters/src/http/**, packages/contracts/src/**, packages/deletion-registry/src/**, apps/platform-web/src/api/**, apps/platform-web/src/features/money/**, apps/platform-web/src/features/marketplace/**, apps/platform-web/src/features/seller/**, apps/platform-web/src/app/router.tsx, tests/integration/rbac/**, scripts/gates/baseline.json, deploy/ec2/**, .env.local.example, docs/billing.md, docs/work-queue.md

Scope: D22 uses Razorpay Subscriptions for hosted checkout, signed recurring lifecycle and cancellation; configured exclusive-GST prices add 18 percent at checkout and collect GSTIN. Prices and credit quantities remain owner configuration, with unconfigured paid plans unavailable. Free-tier verified-email and daily-run limits apply at central admission. V1 marketplace has no paid installation or payout path. Gateway fees are absorbed. No live payment, vendor account or deployment is required for engineering proof.

- [x] G1: Plan definitions persist validated price, provider plan mapping, included credits, extra-credit price, credits per verified run and daily cap; unconfigured paid prices cannot initiate payment
  CHECK: node .unlazy/verify-config.mjs
  EXPECT: payments-config-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4442d112912f1df313e00945daf2b5d9dcb605c3663e6d9fa4461ac7aa003a3a; exit=0; EXPECT=matched; output-sha256=d79ab51bca04ff9247d5f3810c8efb27417cd53244e7b6428e233b75b2baaa51; output-bytes=223; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-payments-c122; path=2b1f1cc87037/31 entries

- [x] G2: Razorpay creates a bounded hosted subscription checkout with configured tax-inclusive provider amount and GSTIN; it never accepts card data, arbitrary provider plans or an unsafe checkout URL
  CHECK: node .unlazy/verify-checkout.mjs
  EXPECT: payments-checkout-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=7b0ca67d5ec3e492daec2fe2422d0a89b5d8809858da1d5cf66f608be57a99b6; exit=0; EXPECT=matched; output-sha256=f8d6c4a4447a09a9cbfc239adbc05589128386e0c61705a8181effce55c64a64; output-bytes=79; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-payments-c122; path=2b1f1cc87037/31 entries

- [x] G3: Authenticated subscription create/change/cancel routes preserve caller scope, idempotency and current versions; creation does not grant paid entitlement before activation
  CHECK: node .unlazy/verify-http.mjs
  EXPECT: payments-http-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=304c2ffa26f0cc593eb772559d681e02581fedccae4a1147cf7fe9872fc3663d; exit=0; EXPECT=matched; output-sha256=ca95e6d51b7db98188a4ba8d5edf1ce74469cf091ad3e636fa0fa083ba00de4a; output-bytes=75; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-payments-c122; path=2b1f1cc87037/31 entries

- [x] G4: Signed duplicate, stale and foreign webhook events cannot change unrelated subscriptions; provider activation, charge, failure and cancellation map to configured internal plans and durable audited lifecycle
  CHECK: node .unlazy/verify-webhooks.mjs
  EXPECT: payments-webhooks-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=d36218e4b833ed3025509e9b44246eca9417a4240e6610690b5a3797cc6f69b5; exit=0; EXPECT=matched; output-sha256=122ed48e8017023a19b274cd9bfa98a18ddaa3599820002bb19e29195e02b6a5; output-bytes=79; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-payments-c122; path=2b1f1cc87037/31 entries

- [x] G5: Real PostgreSQL central run admission enforces configured daily cap atomically across manual, triggered and replay starts; rollback leaves no run or debit, verified-run credits settle once and other tenants remain unaffected
  CHECK: node .unlazy/verify-usage.mjs
  EXPECT: payments-usage-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=f4fa9ff07e15302ce60863f820c56c6fca25e878d14899eddfa3d9d809abdef7; exit=0; EXPECT=matched; output-sha256=82dc16695b9780aaa1b24ae2db8869ccc42d2f70ef9b0f681a7311b670f9b0b6; output-bytes=78; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-payments-c122; path=2b1f1cc87037/31 entries

- [x] G6: V1 free-only marketplace refuses paid publication and install on backend and hides paid checkout, payout and KYC flows; actual free listing install remains functional
  CHECK: node .unlazy/verify-marketplace.mjs
  EXPECT: payments-marketplace-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=30e06ef952827c38e5262948ab7ce0d61497c278b6763e8ae6a03d26e6fa64db; exit=0; EXPECT=matched; output-sha256=465864ee680570440ae22170af9b97ed7e2e044fc179293d9d1616131b96941d; output-bytes=82; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-payments-c122; path=2b1f1cc87037/31 entries

- [x] G7: Live and mock billing render configured base price, 18 percent GST and total, GSTIN validation, hosted checkout, subscription state and cancellation; errors and unavailable configuration remain visible
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: payments-web-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5ebcb6b41f8e3a7d04a03aa7d729836814ab10558c1f0475af4a9329f195a781; exit=0; EXPECT=matched; output-sha256=38da000738f2078c24bf24e77d6d388c22981f400a59b096d033a3c808d85533; output-bytes=74; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-payments-c122; path=2b1f1cc87037/31 entries

- [ ] G8: Meaningful fault controls fail and pass restored code; full affected suites, production configuration, migration rollback, erasure, architecture, RBAC, coverage and normalized AST checks pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: payments-final-passed
  EVIDENCE: pending
