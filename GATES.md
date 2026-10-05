# Gates: D26 read-only tenant detail (C128)

OWNS: apps/platform-api/src/admin-tenants/**, apps/platform-api/src/engine/tenant-activity-client.ts, apps/platform-api/src/engine/tenant-activity-client.spec.ts, apps/platform-api/src/engine/engine.module.ts, apps/platform-api/src/engine/index.ts, apps/platform-api/vitest.config.ts, apps/orchestration-service/src/tenant-activity/**, apps/orchestration-service/src/app.module.ts, apps/orchestration-service/src/execution-runtime.module.ts, apps/cost-ledger-service/src/rollup/**, apps/cost-ledger-service/src/app.module.ts, packages/contracts/src/tenant-activity.ts, packages/contracts/src/tenant-activity.spec.ts, packages/contracts/src/index.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/live-admin-tenants.ts, apps/platform-web/src/api/live-admin-tenants.spec.ts, apps/platform-web/src/api/services/admin-tenants.ts, apps/platform-web/src/features/admin/pages/tenants/**, tests/integration/tenant-activity/**, scripts/gates/baseline.json, docs/work-queue.md, docs/tenant-admin-detail.md

Scope: Build D26 tenant detail from actual member, workflow, run and billed execution-spend records. Read-only, bounded member/workflow/recent-run views with exact thirty-day counts and spend by currency. Current staff roles and scoped support grants remain required; service-asserted tenant reads stay authenticated, audited and under ordinary-role RLS. Missing/upstream failure is explicit rather than fabricated zero. Existing staff notes, entitlement and suspension behavior remain. Security-review assignment, billing operations and tenant deployments are separate required D26 work.

- [ ] G1: Ordinary PostgreSQL returns only the named tenant's actual members, workflows and thirty-day runs, exact boundary counts and bounded lists; deleted subjects and unrelated tenants do not contribute
  CHECK: node .unlazy/verify-detail-storage.mjs
  EXPECT: tenant-detail-storage-passed
  EVIDENCE: pending

- [ ] G2: Actual ledger projection computes billed minor units by currency using its existing billing rule over recorded cost events in the same bounded time window without returning internal costs or margins; zero and unavailable are distinguishable
  CHECK: node .unlazy/verify-detail-costs.mjs
  EXPECT: tenant-detail-costs-passed
  EVIDENCE: pending

- [ ] G3: Actual staff-cookie HTTP and authenticated cross-service transport enforce current staff roles, active matching support grants and service-only tenant assertions; reads are attributed and malformed/upstream/audit failure is explicit
  CHECK: node .unlazy/verify-detail-http.mjs
  EXPECT: tenant-detail-http-passed
  EVIDENCE: pending

- [ ] G4: Live and demo tenant detail show actual bounded members, workflows, recent runs, thirty-day counts and billed spend with currency and period; loading, empty, unavailable and retry states remain truthful
  CHECK: node .unlazy/verify-detail-web.mjs
  EXPECT: tenant-detail-web-passed
  EVIDENCE: pending

- [ ] G5: Original/fault/restored controls prove tenant filters, time boundaries, billable-only projection and authorization; integrated affected suites, coverage, static/build, production wiring and architecture/RBAC/AST checks pass
  CHECK: node .unlazy/verify-detail-final.mjs
  EXPECT: tenant-detail-final-passed
  EVIDENCE: pending
