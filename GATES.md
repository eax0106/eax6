# Gates: D26 read-only tenant detail (C128)

OWNS: apps/platform-api/src/admin-tenants/**, apps/platform-api/src/engine/tenant-activity-client.ts, apps/platform-api/src/engine/tenant-activity-client.spec.ts, apps/platform-api/src/engine/engine.module.ts, apps/platform-api/src/engine/index.ts, apps/platform-api/vitest.config.ts, apps/orchestration-service/src/tenant-activity/**, apps/orchestration-service/src/app.module.ts, apps/orchestration-service/src/execution-runtime.module.ts, apps/cost-ledger-service/src/rollup/**, apps/cost-ledger-service/src/app.module.ts, packages/contracts/src/tenant-activity.ts, packages/contracts/src/tenant-activity.spec.ts, packages/contracts/src/index.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/live-admin-tenants.ts, apps/platform-web/src/api/live-admin-tenants.spec.ts, apps/platform-web/src/api/services/admin-tenants.ts, apps/platform-web/src/features/admin/pages/tenants/**, tests/integration/tenant-activity/**, scripts/gates/baseline.json, docs/work-queue.md, docs/tenant-admin-detail.md

Scope: Build D26 tenant detail from actual member, workflow, run and billed execution-spend records. Read-only, bounded member/workflow/recent-run views with exact thirty-day counts and spend by currency. Current staff roles and scoped support grants remain required; service-asserted tenant reads stay authenticated, audited and under ordinary-role RLS. Missing/upstream failure is explicit rather than fabricated zero. Existing staff notes, entitlement and suspension behavior remain. Security-review assignment, billing operations and tenant deployments are separate required D26 work.

- [x] G1: Ordinary PostgreSQL returns only the named tenant's actual members, workflows and thirty-day runs, exact boundary counts and bounded lists; deleted subjects and unrelated tenants do not contribute
  CHECK: node .unlazy/verify-detail-storage.mjs
  EXPECT: tenant-detail-storage-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=14edfb6bda03ec21d957067243d4d5c0fdcc6d3d019c7315d06898de3d834232; exit=0; EXPECT=matched; output-sha256=27730bf7bde22c191ab3d7eb26ee08ce75cbe446ab1d9650dd8750c28ea29261; output-bytes=166; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-admin-detail-c128; path=2b1f1cc87037/31 entries

- [x] G2: Actual ledger projection computes billed minor units by currency using its existing billing rule over recorded cost events in the same bounded time window without returning internal costs or margins; zero and unavailable are distinguishable
  CHECK: node .unlazy/verify-detail-costs.mjs
  EXPECT: tenant-detail-costs-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=c137a124090b0981a3beae71b43c22dfa54556fe0cc437cb9ebc051e46d5dd92; exit=0; EXPECT=matched; output-sha256=c29f6a81b094c9c02f568fc56dcfa0b4c97cfe37cac0290a8c53e8781a079367; output-bytes=81; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-admin-detail-c128; path=2b1f1cc87037/31 entries

- [x] G3: Actual staff-cookie HTTP and authenticated cross-service transport enforce current staff roles, active matching support grants and service-only tenant assertions; reads are attributed and malformed/upstream/audit failure is explicit
  CHECK: node .unlazy/verify-detail-http.mjs
  EXPECT: tenant-detail-http-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8fb4833cacacd31032b9aa9999f285cc45a12561550544e8c45632e0d62156fc; exit=0; EXPECT=matched; output-sha256=faf29012871767fc0fb1c9817890bae0f8432fa6c71822f68caddefdb5179f32; output-bytes=158; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-admin-detail-c128; path=2b1f1cc87037/31 entries

- [x] G4: Live and demo tenant detail show actual bounded members, workflows, recent runs, thirty-day counts and billed spend with currency and period; loading, empty, unavailable and retry states remain truthful
  CHECK: node .unlazy/verify-detail-web.mjs
  EXPECT: tenant-detail-web-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=c034e7198242b5b127be6a6b6f0c3a8a6b52e19d6f7d2bf8a47183430ecc6dac; exit=0; EXPECT=matched; output-sha256=5036f3300fabf3abb2f01bd294a5033e77199e233a8ca4c03273b05ea52965da; output-bytes=79; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-admin-detail-c128; path=2b1f1cc87037/31 entries

- [x] G5: Original/fault/restored controls prove tenant filters, time boundaries, billable-only projection and authorization; integrated affected suites, coverage, static/build, production wiring and architecture/RBAC/AST checks pass
  CHECK: node .unlazy/verify-detail-final.mjs
  EXPECT: tenant-detail-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=05758c950817ed9f01ea2b5e9ef2af5d56b217a3cbd195aeb8752a658852e520; exit=0; EXPECT=matched; output-sha256=70b2046d5e8d9753b4d57d441d20f8019d3d0339f112392ff4944692b0656423; output-bytes=1208; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-admin-detail-c128; path=2b1f1cc87037/31 entries
