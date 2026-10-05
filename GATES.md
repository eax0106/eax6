# Gates: Configured extra-credit purchase (C133)

OWNS: apps/platform-api/src/credit-purchases/**, apps/platform-api/src/billing/billing.module.ts, apps/platform-api/src/billing/billing-webhook.service.ts, apps/platform-api/src/db/migrations/0038_credit_purchases.sql, apps/platform-api/src/db/migrations/rollback/0038_drop_credit_purchases.sql, apps/platform-api/src/db/migrations/meta/_journal.json, apps/platform-api/src/db/migration-journal.spec.ts, apps/platform-api/src/deletion/**, packages/shared-clients/src/credit-purchase.ts, packages/shared-clients/src/index.ts, packages/adapters/src/razorpay/razorpay-credit-purchase-provider.ts, packages/adapters/src/razorpay/razorpay-credit-purchase-provider.spec.ts, packages/adapters/src/index.ts, packages/contracts/src/credit-purchase.ts, packages/contracts/src/credit-purchase.spec.ts, packages/contracts/src/index.ts, packages/deletion-registry/src/declaration.ts, apps/platform-web/src/api/services/billing.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/credit-purchase.spec.ts, apps/platform-web/src/features/money/pages/billing-overview.tsx, apps/platform-web/src/features/money/pages/credit-purchase.spec.tsx, apps/platform-web/src/features/money/pages/credit-purchase.tsx, docs/credit-purchase.md, docs/work-queue.md, scripts/gates/baseline.json

Scope: Tenant billing managers can buy a configured quantity of extra credits through actual Razorpay-hosted checkout. The server snapshots the displayed configuration version, credit quantity, integer base price, configured D22 GST and total, retaining GSTIN without storing payment instruments. No configuration means unavailable. Provider uncertainty never starts a second purchase blindly. Only a fully paid matching durable purchase can enqueue its immutable credits through existing idempotent Engine delivery. Returning from checkout never proves payment. Native tenant isolation, current authorization, mandatory audit, immutable history, erasure, migration replay and paired rollback are required. Development never executes a live charge or sends customer notifications.

- [ ] G1: Actual Razorpay adapter HTTP on a controlled provider edge validates hosted-link creation and lookup identity, references, amount, currency, paid state and complete unique-reference lookup; ambiguous submission can reconcile the same durable reference and never fabricates success
  CHECK: node .unlazy/verify-credit-purchase-provider.mjs
  EXPECT: credit-purchase-provider-passed
  EVIDENCE: pending

- [ ] G2: Ordinary FORCE RLS PostgreSQL serializes the immutable purchase snapshot, full GSTIN/actor/configuration binding, exact locked revisions, payment identity and quantity; unpaid, partial, wrong-amount, stale, foreign or conflicting payment cannot grant credits; retries and migration replay preserve a single purchase
  CHECK: node .unlazy/verify-credit-purchase-storage.mjs
  EXPECT: credit-purchase-storage-passed
  EVIDENCE: pending

- [ ] G3: Actual tenant-cookie HTTP and production module wiring enforce current billing authorization, strict requests and displayed plan revision, valid acknowledged audit before local commit, provider deadlines, signed webhook authentication and durable named-purchase reconciliation; unauthorized and forged actors fail
  CHECK: node .unlazy/verify-credit-purchase-http.mjs
  EXPECT: credit-purchase-http-passed
  EVIDENCE: pending

- [ ] G4: Live rendered billing UI uses current configured credit prices, explains quantity and integer GST total, opens only actual validated hosted checkout, retains rejected input and shows pending versus delivered credits without claiming payment from a return URL; explicit unavailable/empty/demo states pass
  CHECK: node .unlazy/verify-credit-purchase-web.mjs
  EXPECT: credit-purchase-web-passed
  EVIDENCE: pending

- [ ] G5: Actual Engine credit delivery remains exact-once after uncertain acknowledgement or duplicate paid notification, preserved balance/admission charge verified runs only, and registered guarded erasure/downgrade removes the named tenant while preserving another tenant
  CHECK: node .unlazy/verify-credit-purchase-delivery.mjs
  EXPECT: credit-purchase-delivery-passed
  EVIDENCE: pending

- [ ] G6: Original and distinct behavioral fault controls fail normally and restored code passes; full affected API coverage, web, adapters, Engine and shared suites, static/build, current production wiring, architecture/RBAC/migration/naming and normalized AST checks pass without weakened thresholds or protections
  CHECK: node .unlazy/verify-credit-purchase-final.mjs
  EXPECT: credit-purchase-final-passed
  EVIDENCE: pending
