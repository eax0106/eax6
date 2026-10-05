# Gates: Real staff billing operations (C132)

OWNS: apps/platform-api/src/billing/**, apps/platform-api/src/db/migrations/0037_admin_billing_operations.sql, apps/platform-api/src/db/migrations/rollback/0037_drop_admin_billing_operations.sql, apps/platform-api/src/db/migrations/meta/_journal.json, apps/platform-api/src/db/migration-journal.spec.ts, apps/platform-api/src/deletion/**, apps/platform-api/src/engine/billing-policy-client.ts, apps/platform-web/src/api/live-admin-commerce.spec.ts, packages/contracts/src/staff-billing-operations.ts, packages/contracts/src/staff-billing-operations.spec.ts, packages/contracts/src/index.ts, packages/deletion-registry/src/declaration.ts, apps/platform-web/src/api/services/billing-ops.ts, apps/platform-web/src/api/live-admin-commerce.ts, apps/platform-web/src/api/live-admin-billing-ops.ts, apps/platform-web/src/api/live-admin-billing-ops.spec.ts, apps/platform-web/src/features/admin/pages/platform/billing-ops.tsx, apps/platform-web/src/features/admin/pages/platform/billing-ops.spec.tsx, docs/staff-billing-operations.md, docs/decisions/2026-09-29-owner-decisions.md, docs/work-queue.md, scripts/gates/baseline.json

Scope: Current staff Admin/Billing Ops can act on real named-tenant billing issues with human reason and exact locked revision. The owner explicitly confirmed Apply credit grants extra verified-run credits. Retrying returns the actual Razorpay-hosted recovery link after provider status binding; it never fabricates a server charge or successful payment. Resolve requires current provider-bound paid recovery evidence, updates entitlement/dunning through existing policy mechanisms, and never grants unpaid access. Full attributed local history and acknowledged central audit precede local commit. Credit grants have durable idempotent Engine delivery and remain visibly pending until delivery is acknowledged. Existing refund/dispute behavior, tenant balances/admission, signature-only webhooks, erasure and protections are retained. No live financial operation is executed during development.

- [x] G1: Ordinary PostgreSQL proves current-revision serialized staff operations, full human reasons, provider-bound recovery, no unpaid resolution, durable exact-once run-credit delivery, audit rollback, tenant isolation and guarded downgrade
  CHECK: node .unlazy/verify-billing-ops-storage.mjs
  EXPECT: billing-ops-storage-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4f0ff0bb45c9c78d30e27e7a2c5ddc966d8ca61f67697aeca68142713e378cec; exit=0; EXPECT=matched; output-sha256=f2886efc3beaa7ed69328d5a47cee12454eec17f63b56e77b91406789f4a71be; output-bytes=158; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-billing-ops-c132; path=2b1f1cc87037/31 entries

- [x] G2: Actual staff-cookie HTTP requires current active Admin/Billing Ops, strict named subject and reason, missing/stale revision rejection, provider deadline/error handling, current authoritative payment evidence and mandatory acknowledged audit; unauthorized and forged actors fail
  CHECK: node .unlazy/verify-billing-ops-http.mjs
  EXPECT: billing-ops-http-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=f01c999bde33b53256fb823e9b67468a5672987a128dbb9777c636a18c39669f; exit=0; EXPECT=matched; output-sha256=91a31bf7336370d6ddc806cc6c46ff4bb3856b20452f5c9f830bf9feabfc1526; output-bytes=218; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-billing-ops-c132; path=2b1f1cc87037/31 entries

- [x] G3: Live and demo billing UI use explicit human reasons and displayed revision, show run-credit quantity and delivery state, keep rejected forms recoverable, display actual Razorpay recovery links without claiming payment, and distinguish unavailable, empty and stale states
  CHECK: node .unlazy/verify-billing-ops-web.mjs
  EXPECT: billing-ops-web-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=d2247262a62eaba9d0a326eb65f320b9a6a6d460f449c45fef1e80bd1b96824d; exit=0; EXPECT=matched; output-sha256=57819b23d1d3d745477e6538dee4d9035f3f07a3f1484ebdfa2d2be745779306; output-bytes=212; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-billing-ops-c132; path=2b1f1cc87037/31 entries

- [x] G4: Durable retry reuses the same credit grant after uncertain acknowledgement, preserved balances and admission charge only verified outcomes, and registered erasure removes staff history/delivery without touching another tenant; real migration reapply/downgrade paths pass
  CHECK: node .unlazy/verify-billing-ops-delivery.mjs
  EXPECT: billing-ops-delivery-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=b95c8593eab73a4a55e68a8b55e4cd90767b64ecca43f36d33e101687f451352; exit=0; EXPECT=matched; output-sha256=c7fa166eff5dd0df794d46af8abaf6beced082d4902d19dc5ac38e9e8ec4cd06; output-bytes=344; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-billing-ops-c132; path=2b1f1cc87037/31 entries

- [x] G5: Old/fault/restored behavior controls, affected full API coverage and web/shared suites, production module wiring, static/build, architecture/RBAC/migration/naming and normalized AST checks pass without weakened thresholds or protections
  CHECK: node .unlazy/verify-billing-ops-final.mjs
  EXPECT: billing-ops-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=63b5c7b51c13e3ed094906d201333844578c139d948e54dd886512251b497dc7; exit=0; EXPECT=matched; output-sha256=5ef1a7fdd52e1cad6c71b0afbd3a696267a3e6493168a413a5e5d7708a1825b3; output-bytes=985; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-billing-ops-c132; path=2b1f1cc87037/31 entries
