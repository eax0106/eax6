# Gates: D26 security-review assignment (C129)

OWNS: tests/integration/security-review/**, apps/platform-api/vitest.config.ts, apps/platform-api/src/abuse/**, apps/platform-api/src/db/migrations/0036_security_review_assignment.sql, apps/platform-api/src/db/migrations/rollback/0036_drop_security_review_assignment.sql, apps/platform-api/src/db/migrations/meta/_journal.json, apps/platform-api/src/deletion/platform-deletion.integration.spec.ts, apps/platform-api/src/deletion/platform-deletion.service.ts, packages/deletion-registry/src/declaration.ts, packages/contracts/src/index.ts, packages/contracts/src/operations.ts, packages/contracts/src/operations.spec.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/live-admin-ops.ts, apps/platform-web/src/api/live-admin-ops.spec.ts, apps/platform-web/src/api/services/security.ts, apps/platform-web/src/features/admin/pages/governance/security-queue.tsx, apps/platform-web/src/features/admin/pages/governance/security-queue.spec.tsx, scripts/gates/baseline.json, docs/security-review-assignment.md, docs/work-queue.md

Scope: Persist assignment of an open security review to a currently active staff_admin or staff_security member selected from actual eligible staff. Preserve existing staff-only queue and review behavior. Attribution, human reason and exact revision survive reload; assignments and decisions serialize on the same locked signal and require central audit acknowledgement before commit. Assignment does not manufacture a new abuse signal or silently clear an existing resolution. Read/mutation failures, stale state and unavailable staff remain explicit in live and demo UI. Tenant erasure removes the existing signal and its added assignment fields under the existing manifest. D26 billing operations and tenant deployments remain separate required work.

- [x] G1: Actual ordinary PostgreSQL retains the assignee, assigner, human reason and monotonic revision; inactive or ineligible staff, closed signals, missing and stale revisions fail; assignment and review audit failure rolls back the entire write
  CHECK: node .unlazy/verify-assignment-storage.mjs
  EXPECT: security-assignment-storage-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8b048f53bd8a66475773831f9d2989e4b50601c18a6777ea3f8c90a1638db604; exit=0; EXPECT=matched; output-sha256=d15317f30ac96d7d0c84bcd0d6235c659c7a08602bb2f5d0f1a67a3b95d92774; output-bytes=172; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-security-assignment-c129; path=2b1f1cc87037/31 entries

- [x] G2: Current authenticated staff-cookie HTTP enforces the queue's existing staff_admin/staff_security roles, strict requests and exact revisions; the staff picker contains only actual currently eligible staff, attribution is server supplied and central audit validation accepts the write payload
  CHECK: node .unlazy/verify-assignment-http.mjs
  EXPECT: security-assignment-http-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=d950e2474bc14ede302e03f00b6a83a8fb57204c321c31b0791764f5dae8a0fa; exit=0; EXPECT=matched; output-sha256=893e59929b1118f0d2642b2a9e6bdda13bb8c71d62df3ab43b02740a0d37bc55; output-bytes=86; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-security-assignment-c129; path=2b1f1cc87037/31 entries

- [x] G3: Live and demo security queue supports choosing an eligible staff member and entering a reason, shows recorded assignee after reload, carries exact revision for assignment and review, and handles loading, empty, stale, disabled and upstream-error states truthfully
  CHECK: node .unlazy/verify-assignment-web.mjs
  EXPECT: security-assignment-web-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=df9a90d105b1d1ffc2b9d8f953f058b359c730c8c9495f7afd59f9746eff8355; exit=0; EXPECT=matched; output-sha256=396d4524ba5c055d873df8c2051e6833da0e020477cd251ca174316a11791a73; output-bytes=150; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-security-assignment-c129; path=2b1f1cc87037/31 entries

- [x] G4: Migration and rollback preserve existing reviews and refuse destructive downgrade with assignment history; tenant erasure removes the target signal without affecting unrelated tenants; original/fault/restored controls and full API/web/static/coverage/architecture/RBAC/AST checks pass
  CHECK: node .unlazy/verify-assignment-final.mjs
  EXPECT: security-assignment-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8176dac76c218f3ea4c9216925ba502d56c45c845ebb04520e6090b06a8e5025; exit=0; EXPECT=matched; output-sha256=99316bf97b7206f808f3a06545ae55a2b9fcc58ac8f6347d7be6bd026f27745b; output-bytes=1018; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-security-assignment-c129; path=2b1f1cc87037/31 entries
