# Gates: service-read audit context (C104)

OWNS: apps/orchestration-service/src/runs/run-learning.controller.ts, apps/orchestration-service/src/runs/run-learning-audit.integration.spec.ts, apps/audit-service/src/audit/run-learning.fixture.spec.ts, docs/work-queue.md, scripts/gates/baseline.json

Scope: Use the existing allowed audit context for service-asserted run summaries and preserve the caller, asserted tenant, run and result. Prove the actual guarded HTTP, database and authenticated audit gRPC path. Internal performance authentication remains a separate required follow-up.

- [ ] G1: Restricted PostgreSQL and signed HTTP return an owned summary, explicitly refuse a tenant mismatch, and persist successful and denied reads through the actual authenticated audit gRPC service
  CHECK: node .unlazy/verify-native.mjs
  EXPECT: run-learning-audit-native-passed
  EVIDENCE: pending

- [ ] G2: The original context fails the persisted-audit assertions and restoring the production context passes
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: run-learning-audit-negative-passed
  EVIDENCE: pending

- [ ] G3: Full engine and audit suites, build, typecheck, lint, architecture, rollback pairing, RBAC and zero added AST findings pass
  CHECK: node .unlazy/verify-full.mjs
  EXPECT: run-learning-audit-full-passed
  EVIDENCE: pending
