# Gates: Configured extra-credit purchase (C142, continuing C133)

OWNS: apps/platform-api/vitest.config.ts, deploy/ec2/platform-db-roles.sql, deploy/ec2/check-platform-db-roles.sh, apps/platform-api/src/billing/billing-runtime.native.spec.ts, apps/platform-api/src/credit-purchases/**, apps/platform-api/src/billing/billing.module.ts, apps/platform-api/src/billing/billing.module.spec.ts, apps/platform-api/src/billing/billing-webhook.service.ts, apps/platform-api/src/db/migrations/0038_credit_purchases.sql, apps/platform-api/src/db/migrations/rollback/0038_drop_credit_purchases.sql, apps/platform-api/src/db/migrations/meta/_journal.json, apps/platform-api/src/db/migration-journal.spec.ts, apps/platform-api/src/deletion/**, packages/shared-clients/src/credit-purchase.ts, packages/shared-clients/src/index.ts, packages/adapters/src/razorpay/razorpay-credit-purchase-provider.ts, packages/adapters/src/razorpay/razorpay-credit-purchase-provider.spec.ts, packages/adapters/src/index.ts, packages/contracts/src/credit-purchase.ts, packages/contracts/src/credit-purchase.spec.ts, packages/contracts/src/index.ts, packages/deletion-registry/src/declaration.ts, apps/platform-web/src/api/services/billing.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/credit-purchase.spec.ts, apps/platform-web/src/features/money/pages/billing-overview.tsx, apps/platform-web/src/features/money/pages/credit-purchase.spec.tsx, apps/platform-web/src/features/money/pages/credit-purchase.tsx, docs/credit-purchase.md, docs/work-queue.md, scripts/gates/baseline.json

Scope: Tenant billing managers can buy a configured quantity of extra credits through actual Razorpay-hosted checkout. The server snapshots the displayed configuration version, credit quantity, integer base price, configured D22 GST and total, retaining GSTIN without storing payment instruments. No configuration means unavailable. Provider uncertainty never starts a second purchase blindly. Only a fully paid matching durable purchase can enqueue its immutable credits through existing idempotent Engine delivery. Returning from checkout never proves payment. Native tenant isolation, current authorization, mandatory audit, immutable history, erasure, migration replay and paired rollback are required. Development never executes a live charge or sends customer notifications.

- [x] G1: Actual Razorpay adapter HTTP on a controlled provider edge validates hosted-link creation and lookup identity, references, amount, currency, paid state and complete unique-reference lookup; ambiguous submission can reconcile the same durable reference and never fabricates success
  CHECK: node .unlazy/verify-credit-purchase-provider.mjs
  EXPECT: credit-purchase-provider-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=0a5b4c4684b15c92b7fe5519f9b345b95280649d5af254c9c770813c21e0ee29; exit=0; EXPECT=matched; output-sha256=c85d28d7dffc1a9d87b519535d74b639f4ba6d2cdf53966a4c564092d1804ec4; output-bytes=163; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-credit-finish-c142; path=80f8443873c7/30 entries

- [x] G2: Ordinary FORCE RLS PostgreSQL serializes the immutable purchase snapshot, full GSTIN/actor/configuration binding, exact locked revisions, payment identity and quantity; unpaid, partial, wrong-amount, stale, foreign or conflicting payment cannot grant credits; retries and migration replay preserve a single purchase; inactive tenants cannot monopolize bounded reconciliation inventory
  CHECK: node .unlazy/verify-credit-purchase-storage.mjs
  EXPECT: credit-purchase-storage-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=fb798e7604299f81568e685c185de61ce5c8f83c6f7cc42ba2939615fb2d8815; exit=0; EXPECT=matched; output-sha256=20631acdac67ed5f87364ca29b3f88269fceb6420d05728498aba61d2491652a; output-bytes=85; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-credit-finish-c142; path=80f8443873c7/30 entries

- [x] G3: Actual tenant-cookie HTTP and production module wiring enforce current billing authorization, strict requests and displayed plan revision, valid acknowledged audit before local commit, provider deadlines, signed webhook authentication and durable named-purchase reconciliation; unauthorized and forged actors fail
  CHECK: node .unlazy/verify-credit-purchase-http.mjs
  EXPECT: credit-purchase-http-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=9955a4b3810fb02f9fa2380432d4c04376a43ca66ad8c54be8d3e2b57ad4c579; exit=0; EXPECT=matched; output-sha256=e63462a6b2e8df70d26f745b863ed160f8fa313d7537f1fcc39b43ce7c1e8224; output-bytes=170; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-credit-finish-c142; path=80f8443873c7/30 entries

- [x] G4: Live rendered billing UI uses current configured credit prices, explains quantity and integer GST total, opens only actual validated hosted checkout, retains rejected input and shows pending versus delivered credits without claiming payment from a return URL; explicit unavailable/empty/demo states pass
  CHECK: node .unlazy/verify-credit-purchase-web.mjs
  EXPECT: credit-purchase-web-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8d6f4be13a6aba04f4562819ea1ef282b851af0a7e569b5174787ee67438fede; exit=0; EXPECT=matched; output-sha256=2ee18b96b4e9dbcd7013d8bed1b759e0fd9eea0e618012b627c0ad3d87ed5a17; output-bytes=81; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-credit-finish-c142; path=80f8443873c7/30 entries

- [x] G5: Actual Engine credit delivery remains exact-once after uncertain acknowledgement or duplicate paid notification, preserved balance/admission charge verified runs only, and registered guarded erasure/downgrade removes the named tenant while preserving another tenant
  CHECK: node .unlazy/verify-credit-purchase-delivery.mjs
  EXPECT: credit-purchase-delivery-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=c10ca72789961ff04f741d53787c6822153601c94d0adee8cf217fa02b40fdbe; exit=0; EXPECT=matched; output-sha256=530a5eb068c15c69416cb29e51f53f3214a6bc6f5307f29fe8d135fee01f6b7c; output-bytes=236; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-credit-finish-c142; path=80f8443873c7/30 entries

- [x] G6: Original and distinct behavioral fault controls fail normally and restored code passes; full affected API coverage, web, adapters, Engine and shared suites, static/build, current production wiring, architecture/RBAC/migration/naming and normalized AST checks pass without weakened thresholds or protections
  CHECK: node .unlazy/verify-credit-purchase-final.mjs
  EXPECT: credit-purchase-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=ebc8b4ab59256da186653c634a684adb9132457af52f0c79e02d01a266c64bb0; exit=0; EXPECT=matched; output-sha256=742fee73c3ac374e23abb7687acb8a6565fa8b1cf72c1012793c307576c6b7ac; output-bytes=1391; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-credit-finish-c142; path=80f8443873c7/30 entries
