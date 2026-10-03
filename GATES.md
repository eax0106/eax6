# Gates: D9 workflow folders (C115)

OWNS: apps/orchestration-service/drizzle/0052_workflow_folders.sql, apps/orchestration-service/drizzle/rollback/0052_restore_workflow_folders.sql, apps/orchestration-service/drizzle/meta/_journal.json, apps/orchestration-service/db/schema/workflows.ts, apps/orchestration-service/db/schema/workflow_folders.ts, apps/orchestration-service/src/workflow-folders/**, apps/orchestration-service/src/workflow-authoring.module.ts, apps/orchestration-service/src/workflow-read/**, apps/orchestration-service/src/database/migration-files.spec.ts, apps/orchestration-service/src/deletion/**, apps/platform-api/src/workflow-folders/**, apps/platform-api/src/workflows/**, apps/platform-api/src/app.module.ts, apps/platform-web/src/api/workflow-folders.ts, apps/platform-web/src/api/workflow-folders.spec.ts, apps/platform-web/src/api/client.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/query-keys.ts, apps/platform-web/src/features/workflows/**, apps/platform-web/src/layout/sidebar.tsx, packages/contracts/src/workflow-folders.ts, packages/contracts/src/workflow-folders.spec.ts, packages/contracts/src/index.ts, packages/deletion-registry/src/**, scripts/gates/baseline.json, docs/work-queue.md, apps/platform-api/src/engine/engine-client.ts, apps/platform-api/src/engine/engine-client.spec.ts, apps/platform-web/src/api/live.ts

Scope: D9 adds engine-owned, named workspace folders. Every workflow has an optional folder; no folder means Ungrouped. Create, rename, delete and move preserve workspace context. Deleting a folder returns its workflows to Ungrouped and never deletes workflows, chats or runs. Engine projects retain their existing meaning. ADS already validates the actual workspace; this task adds no broader retrieval scope. C110 chat migration0051 precedes folder migration0052. Shared integration files with C110/C113/C114 will be ordered and declared in the PR.

- [ ] G1: Restricted PostgreSQL proves folder create/read/rename/delete and workflow moves in the actual workspace, with primary identities and atomic deletion returning only that folder's workflows to Ungrouped
  CHECK: node .unlazy/verify-storage.mjs
  EXPECT: workflow-folders-storage-passed
  EVIDENCE: pending

- [ ] G2: Migration upgrade/rollback/reapply and registered tenant/workspace erasure preserve unrelated workflows, chats, runs and folders under ordinary runtime row policies
  CHECK: node .unlazy/verify-lifecycle.mjs
  EXPECT: workflow-folders-lifecycle-passed
  EVIDENCE: pending

- [ ] G3: Actual guarded engine HTTP and Platform API transport enforce workspace-bound reads and admin/editor writes, pass real caller context and require resource preconditions for edits
  CHECK: node .unlazy/verify-http.mjs
  EXPECT: workflow-folders-http-passed
  EVIDENCE: pending

- [ ] G4: Live web requests and rendered workflow grouping show actual folders plus Ungrouped, support create/rename/delete/move, and preserve errors, stale-edit recovery and readable access
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: workflow-folders-web-passed
  EVIDENCE: pending

- [ ] G5: Removing each consequential workspace, parent, atomic-delete, precondition, role or live-route check fails its known-positive assertion and restored sources pass
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: workflow-folders-controls-passed
  EVIDENCE: pending

- [ ] G6: Full touched suites, actual recursive engine discovery, build/typecheck/lint, paired migration and erasure registration, architecture/RBAC/naming and zero added normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: workflow-folders-final-passed
  EVIDENCE: pending
