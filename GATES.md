# Gates: service-read audit context (C104)

OWNS: apps/orchestration-service/src/runs/run-learning.controller.ts, apps/orchestration-service/src/runs/run-learning-audit.integration.spec.ts, apps/audit-service/src/audit/run-learning.fixture.spec.ts, docs/work-queue.md, scripts/gates/baseline.json

Scope: Use the existing allowed audit context for service-asserted run summaries and preserve the caller, asserted tenant, run and result. Prove the actual guarded HTTP, database and authenticated audit gRPC path. Internal performance authentication remains a separate required follow-up.

- [x] G1: Restricted PostgreSQL and signed HTTP return an owned summary, explicitly refuse a tenant mismatch, and persist successful and denied reads through the actual authenticated audit gRPC service
  CHECK: node .unlazy/verify-native.mjs
  EXPECT: run-learning-audit-native-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=47e907bc9ee2ff4545c6daf57bf2eb95590737504078b67542145bfba94ce2bb; exit=0; EXPECT=matched; output-sha256=ecf2e05d22a684b7ea1915930169ca01c9187889154b4abe41b6cce52bfb0554; output-bytes=87; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-run-learning-audit-c104; path=b33e9cf43ae9/31 entries

- [x] G2: The original context fails the persisted-audit assertions and restoring the production context passes
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: run-learning-audit-negative-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=c8997c92b7e69a588b9df1a48531eb275c307ce72477219836e86f2799d5233c; exit=0; EXPECT=matched; output-sha256=acc3480c9978ff2efd668f05ab5da20b33d51d1879e446e8cd60f0825d7e19ef; output-bytes=293; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-run-learning-audit-c104; path=b33e9cf43ae9/31 entries

- [x] G3: Full engine and audit suites, build, typecheck, lint, architecture, rollback pairing, RBAC and zero added AST findings pass
  CHECK: node .unlazy/verify-full.mjs
  EXPECT: run-learning-audit-full-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=90cb684a6b666da8881b9d079dc3ed2ef03d75e86fd95db0ad839e05fd968602; exit=0; EXPECT=matched; output-sha256=ad6aad29e37ea4f60acde75403f8ceef38259e2ea817849ab95120b100b597bf; output-bytes=568; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-run-learning-audit-c104; path=b33e9cf43ae9/31 entries
