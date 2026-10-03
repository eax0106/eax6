# Gates: D9 workflow folders (C115)

OWNS: apps/orchestration-service/drizzle/0052_workflow_folders.sql, apps/orchestration-service/drizzle/rollback/0052_restore_workflow_folders.sql, apps/orchestration-service/drizzle/meta/_journal.json, apps/orchestration-service/db/schema/workflows.ts, apps/orchestration-service/db/schema/workflow_folders.ts, apps/orchestration-service/src/workflow-folders/**, apps/orchestration-service/src/workflow-authoring.module.ts, apps/orchestration-service/src/workflow-read/**, apps/orchestration-service/src/database/migration-files.spec.ts, apps/orchestration-service/src/deletion/**, apps/platform-api/src/workflow-folders/**, apps/platform-api/src/workflows/**, apps/platform-api/src/app.module.ts, apps/platform-web/src/api/workflow-folders.ts, apps/platform-web/src/api/workflow-folders.spec.ts, apps/platform-web/src/api/client.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/query-keys.ts, apps/platform-web/src/features/workflows/**, apps/platform-web/src/layout/sidebar.tsx, packages/contracts/src/workflow-folders.ts, packages/contracts/src/workflow-folders.spec.ts, packages/contracts/src/index.ts, packages/deletion-registry/src/**, scripts/gates/baseline.json, docs/work-queue.md, apps/platform-api/src/engine/engine-client.ts, apps/platform-api/src/engine/engine-client.spec.ts, apps/platform-web/src/api/live.ts

Scope: D9 adds engine-owned, named workspace folders. Every workflow has an optional folder; no folder means Ungrouped. Create, rename, delete and move preserve workspace context. Deleting a folder returns its workflows to Ungrouped and never deletes workflows, chats or runs. Engine projects retain their existing meaning. ADS already validates the actual workspace; this task adds no broader retrieval scope. C110 chat migration0051 precedes folder migration0052. Shared integration files with C110/C113/C114 will be ordered and declared in the PR.

- [x] G1: Restricted PostgreSQL proves folder create/read/rename/delete and workflow moves in the actual workspace, with primary identities and atomic deletion returning only that folder's workflows to Ungrouped
  CHECK: node .unlazy/verify-storage.mjs
  EXPECT: workflow-folders-storage-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=11c8e14089b6bb42be0620bbdde50a6830e1536eec92a1652af1d46992b39fdd; exit=0; EXPECT=matched; output-sha256=cf33f3e3e2f0e113719718a5dec57644d2232b6ccbfe89a1e2eca5cbe33c648c; output-bytes=148; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workflow-folders-c115; path=b33e9cf43ae9/31 entries

- [x] G2: Migration upgrade/rollback/reapply and registered tenant/workspace erasure preserve unrelated workflows, chats, runs and folders under ordinary runtime row policies
  CHECK: node .unlazy/verify-lifecycle.mjs
  EXPECT: workflow-folders-lifecycle-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=2fd9f3862e7bc51e92e81ea12e70631f201f3920232dee5bd56897f06fd5a9da; exit=0; EXPECT=matched; output-sha256=c96dde4dac1cb8814bac852185775636f159c24e49348c611f84155a144f1435; output-bytes=188; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workflow-folders-c115; path=b33e9cf43ae9/31 entries

- [x] G3: Actual guarded engine HTTP and Platform API transport enforce workspace-bound reads and admin/editor writes, pass real caller context and require resource preconditions for edits
  CHECK: node .unlazy/verify-http.mjs
  EXPECT: workflow-folders-http-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=b123c2cfe717fa86f52453a9ee1c0f838865e38795d9694f8efb83d10f4af0fb; exit=0; EXPECT=matched; output-sha256=aa57d8b20b54271764e1a35276b3e49bf7933b1518e3fdd31f464bb6ba468dca; output-bytes=93; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workflow-folders-c115; path=b33e9cf43ae9/31 entries

- [x] G4: Live web requests and rendered workflow grouping show actual folders plus Ungrouped, support create/rename/delete/move, and preserve errors, stale-edit recovery and readable access
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: workflow-folders-web-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4374d57fc6ee559b5f552ac146281dd0f83e445cef08cf5cd0b1f7b9a6768c35; exit=0; EXPECT=matched; output-sha256=3d564a42770f22e9e956bfe3c4c6079c341563889355848b5872bcf92b4e9e2e; output-bytes=82; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workflow-folders-c115; path=b33e9cf43ae9/31 entries

- [x] G5: Removing each consequential workspace, parent, atomic-delete, precondition, role or live-route check fails its known-positive assertion and restored sources pass
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: workflow-folders-controls-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=3e71e639c46224d7fab61d940847446a482d67a57ad92c3bf280a7b517a95fd9; exit=0; EXPECT=matched; output-sha256=97ce51e5f8b7db2d9da6f52cf45c0cfedaf95ad111c4424ce1a6012f003654b9; output-bytes=5004; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workflow-folders-c115; path=b33e9cf43ae9/31 entries

- [x] G6: Full touched suites, actual recursive engine discovery, build/typecheck/lint, paired migration and erasure registration, architecture/RBAC/naming and zero added normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: workflow-folders-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=7440a85fe3e48489d535aa09a4740a7128d9f016bcb91676dcdc74f9c9fc04f0; exit=0; EXPECT=matched; output-sha256=bad5896e3438fe149738d7e4e14735028882dcb75f500090f9cbedbb8ff2600b; output-bytes=906; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workflow-folders-c115; path=b33e9cf43ae9/31 entries
