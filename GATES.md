# Gates: D6 workflow chat and Ask Alter (C110)

OWNS: apps/orchestration-service/drizzle/0051_workflow_chat.sql, apps/orchestration-service/drizzle/rollback/0051_restore_workflow_chat.sql, apps/orchestration-service/drizzle/meta/_journal.json, apps/orchestration-service/db/schema/workflows.ts, apps/orchestration-service/db/schema/conversations.ts, apps/orchestration-service/db/schema/conversation_messages.ts, apps/orchestration-service/src/database/migration-files.spec.ts, apps/orchestration-service/src/workflow-chat/**, apps/orchestration-service/src/execution-runtime.module.ts, apps/orchestration-service/src/runs/run-workspace-lookup.service.ts, apps/orchestration-service/src/runs/run-workspace-lookup.service.spec.ts, apps/cost-ledger-service/src/ingest/workflow-chat-native.integration.spec.ts, apps/model-gateway/src/gateway/workflow-chat-native.integration.spec.ts, apps/cost-ledger-service/src/ingest/cost-ingest.service.ts, apps/cost-ledger-service/src/ingest/cost-ingest.service.spec.ts, apps/cost-ledger-service/src/ingest/cost-ingest.service.integration.spec.ts, apps/orchestration-service/src/workflow-read/workflow-read.service.ts, apps/orchestration-service/src/workflow-read/workflow-read.controller.ts, apps/orchestration-service/src/workflow-read/workflow-read.service.spec.ts, apps/orchestration-service/src/workflow-authoring.module.ts, apps/orchestration-service/src/deletion/deletion.service.ts, apps/orchestration-service/src/deletion/deletion.integration.spec.ts, packages/deletion-registry/src/**, packages/contracts/src/workflow-chat.ts, packages/contracts/src/index.ts, apps/platform-api/src/workflow-chat/**, apps/platform-api/src/app.module.ts, apps/platform-api/src/planner-facade/planner-facade.module.ts, apps/platform-api/src/workflows/workflow.service.ts, apps/platform-web/src/api/client.ts, apps/platform-web/src/api/live.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/live-conversations.spec.ts, apps/platform-web/src/features/conversations/**, apps/platform-web/src/components/conversation/**, scripts/gates/baseline.json, docs/work-queue.md

Scope: One persistent chat per workflow, workflow title, independently archived conversation and atomic workflow/chat creation. Builder messages retain prior context through the existing understand/plan/clarify/compile flow. One Ask Alter assistant per user in the workspace uses only existing caller-scoped reads and costed Model Gateway calls. Its sole workflow action creates an empty draft and hands off to that draft's chat. Wire all six existing web methods plus home and assistant entry points. No project-mode expansion or new dependency.

- [x] G1: Restricted PostgreSQL and authenticated engine HTTP prove unique workflow chats, atomic creation, stored ordered messages, current workflow title, workspace/user scope, independent archiving, migration rollback and registered tenant/workspace erasure
  CHECK: node .unlazy/verify-storage.mjs
  EXPECT: workflow-chat-storage-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1d26b5470d1e31e31698ccad78d0c3ff5767a9312caae25f22809c6603736285; exit=0; EXPECT=matched; output-sha256=176379cd14e54d8abceafa17b84c804eb8cf69886f68dfd06224f780d5c6df20; output-bytes=83; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workflow-chat-c110; path=b33e9cf43ae9/31 entries

- [x] G2: Native planner/compiler transports reached from the platform chat retain original goal and multiple clarification rounds, return complete connection requirements, save compiled versions and persist replies that describe the actual result
  CHECK: node .unlazy/verify-builder.mjs
  EXPECT: workflow-chat-builder-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=b14aea59b223d07f3cfaefa3319cd3f7fa2a778559c984517271b68d06742074; exit=0; EXPECT=matched; output-sha256=7406c0fd32718c95224280f49a59e1d30fc1a70d755eae14dbd18175b33cd1b2; output-bytes=147; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workflow-chat-c110; path=b33e9cf43ae9/31 entries

- [x] G3: Real caller-authenticated read boundaries and actual Model Gateway/cost recording prove Ask Alter sees readable workspace workflows, recent runs, failures, verification and billed spend; it cannot change existing workflows and its only action creates a draft/chat handoff
  CHECK: node .unlazy/verify-assistant.mjs
  EXPECT: workflow-chat-assistant-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=cf3f66468e5df3524d6459fddacbb11ea84f607b2d0436ae2e5ae606f9baa1ee; exit=0; EXPECT=matched; output-sha256=a69df4a95f6223fd7ac081ef9a16eeb456f4e620a255cad0e31cf9964a96447f; output-bytes=85; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workflow-chat-c110; path=b33e9cf43ae9/31 entries

- [x] G4: All six web methods use live HTTP; rendered home, workflow chat and Ask Alter use actual returned identities, show clarification/results/errors and route draft handoff without mock fallback
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: workflow-chat-web-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=758efc6652f52b9c9bad083a938114bc3be65cd2e366a1ca36f627fa8733e27e; exit=0; EXPECT=matched; output-sha256=f0b2d30bfd85e57600cd0ba44ad44e708ac457e925b67906feeb2ecbf506bb17; output-bytes=77; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workflow-chat-c110; path=b33e9cf43ae9/31 entries

- [x] G5: Removing each consequential scope, ownership, atomicity, context preservation, read-only action, costing or live-route check fails its known-positive native assertion; restored sources pass
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: workflow-chat-negative-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=45ef914989dc4190ffd9a183e1d0787511897d002ad17732aea3cd8a79b8a03f; exit=0; EXPECT=matched; output-sha256=3f2d3baaa9576e98298a724fffd3e9f8aa20f36280ebaf8aad7a1d360781f212; output-bytes=4832; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workflow-chat-c110; path=b33e9cf43ae9/31 entries

- [x] G6: Full touched suites including platform folder coverage, build/typecheck/lint, migration/erasure registration, architecture, RBAC, naming and zero added normalized AST findings pass with actual CI discovery
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: workflow-chat-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5859d580654ef857cd7a07b8a79a53528f1b9c563c09312175423cd64f9bf417; exit=0; EXPECT=matched; output-sha256=ab1e78b7b258ab6c0036dfe45ca2979d6941886bd8a26ef2886f877777164815; output-bytes=1126; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workflow-chat-c110; path=b33e9cf43ae9/31 entries
