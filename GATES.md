# Gates: D26 tenant deployment administration (C130)

OWNS: apps/orchestration-service/src/deployment-admin/**, apps/orchestration-service/src/operations.module.ts, apps/orchestration-service/drizzle/0055_deployment_admin_history.sql, apps/orchestration-service/drizzle/rollback/0055_drop_deployment_admin_history.sql, apps/orchestration-service/drizzle/meta/_journal.json, apps/orchestration-service/src/database/migration-files.spec.ts, apps/orchestration-service/src/deletion/**, apps/platform-api/src/admin-deployments/**, apps/platform-api/src/engine/deployment-admin-client.ts, apps/platform-api/src/engine/deployment-admin-client.spec.ts, packages/contracts/src/operations.ts, packages/contracts/src/operations.spec.ts, packages/contracts/src/index.ts, packages/deletion-registry/src/declaration.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/live-admin-deployments.ts, apps/platform-web/src/api/live-admin-deployments.spec.ts, apps/platform-web/src/api/services/deployments.ts, apps/platform-web/src/features/admin/pages/operations/deployments-list.tsx, apps/platform-web/src/features/admin/pages/operations/deployments-list.spec.tsx, scripts/gates/baseline.json, docs/tenant-deployment-admin.md, docs/work-queue.md

Scope: Replace fictional platform rollouts with recorded named-tenant Engine deployments. Current staff_admin can list and apply rollback, suspend or resume with exact locked revisions, human reason and acknowledged staff audit before local commit. Preserve existing deployment transition rules and retain attributed action history under ordinary tenant RLS and erasure. No infrastructure is provisioned, promoted or deployed by this work. Missing, empty, stale and failed live operations are explicit; demo records remain fictional. D26 billing operations remain required.

- [x] G1: Real ordinary PostgreSQL lists only the named tenant's existing deployments with bounded stable ordering and exact current revisions; transitions serialize and preserve existing rollback and active-deployment rules
  CHECK: node .unlazy/verify-deployment-storage.mjs
  EXPECT: tenant-deployment-storage-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=e9fc55e2a0febee161ff60b64922f269b72ee94cda0a947cc56063a750ab9023; exit=0; EXPECT=matched; output-sha256=406ef94c1020374dfec4fd2bc3c66c86be5b9715515c3e81463e527dbeb3f435; output-bytes=219; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-tenant-deployments-c130; path=2b1f1cc87037/31 entries

- [x] G2: Real staff-cookie HTTP and existing authenticated internal service transport require current staff_admin, strict named-tenant requests, exact revisions and human reasons; failed mandatory audit rolls back the transition and local attributed history
  CHECK: node .unlazy/verify-deployment-http.mjs
  EXPECT: tenant-deployment-http-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=afa986fb494bfbf6212f7ec93862562264912f520a0cf6bcf4d05a10d80b6599; exit=0; EXPECT=matched; output-sha256=abbc51cb045a313601e8b5fa3d2126e150e8433d8aa313bc70cb06f761eec56b; output-bytes=214; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-tenant-deployments-c130; path=2b1f1cc87037/31 entries

- [x] G3: Live and demo tenant deployment UI displays actual tenant and deployment records, submits reason and displayed revision, offers valid rollback/suspend/resume actions, and handles loading, empty, unavailable and stale states without fictional live fallback
  CHECK: node .unlazy/verify-deployment-web.mjs
  EXPECT: tenant-deployment-web-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=05bc494742d0ffd42573dd216c0c6598d2d850ec3ca08d10a6009f7dbd8f90eb; exit=0; EXPECT=matched; output-sha256=3fe5fd73dfa4674a9b5d3488a43953833d1b3e35cc91d97da96fac21c5b2dbbc; output-bytes=166; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-tenant-deployments-c130; path=2b1f1cc87037/31 entries

- [x] G4: History RLS, erasure and paired migration rollback retain unrelated tenant data and legacy deployment records; old/fault/restored behavioral controls, affected full suites with coverage, production wiring, static/build and architecture/RBAC/AST checks pass
  CHECK: node .unlazy/verify-deployment-final.mjs
  EXPECT: tenant-deployment-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1f4b0190475be92d133c326ad017d7dfbb0ade02328cd8821403db19c7fcb429; exit=0; EXPECT=matched; output-sha256=13db61c0d7988c683e4f1c15e6a73acc7c0608eb4745400a65ccaa7878343a3d; output-bytes=1178; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-tenant-deployments-c130; path=2b1f1cc87037/31 entries
