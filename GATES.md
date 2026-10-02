# Gates: D6 workflow chat and Ask Alter (C110)

OWNS: apps/orchestration-service/drizzle/0051_workflow_chat.sql, apps/orchestration-service/drizzle/rollback/0051_restore_workflow_chat.sql, apps/orchestration-service/drizzle/meta/_journal.json, apps/orchestration-service/db/schema/workflows.ts, apps/orchestration-service/db/schema/conversations.ts, apps/orchestration-service/db/schema/conversation_messages.ts, apps/orchestration-service/src/database/migration-files.spec.ts, apps/orchestration-service/src/workflow-chat/**, apps/orchestration-service/src/workflow-read/workflow-read.service.ts, apps/orchestration-service/src/workflow-read/workflow-read.controller.ts, apps/orchestration-service/src/workflow-read/workflow-read.service.spec.ts, apps/orchestration-service/src/workflow-authoring.module.ts, apps/orchestration-service/src/deletion/deletion.service.ts, apps/orchestration-service/src/deletion/deletion.integration.spec.ts, packages/deletion-registry/src/**, packages/contracts/src/workflow-chat.ts, packages/contracts/src/index.ts, apps/platform-api/src/workflow-chat/**, apps/platform-api/src/app.module.ts, apps/platform-api/src/planner-facade/planner-facade.module.ts, apps/platform-api/src/workflows/workflow.service.ts, apps/platform-web/src/api/client.ts, apps/platform-web/src/api/live.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/live-conversations.spec.ts, apps/platform-web/src/features/conversations/**, apps/platform-web/src/components/conversation/**, scripts/gates/baseline.json, docs/work-queue.md

Scope: One persistent chat per workflow, workflow title, independently archived conversation and atomic workflow/chat creation. Builder messages retain prior context through the existing understand/plan/clarify/compile flow. One Ask Alter assistant per user in the workspace uses only existing caller-scoped reads and costed Model Gateway calls. Its sole workflow action creates an empty draft and hands off to that draft's chat. Wire all six existing web methods plus home and assistant entry points. No project-mode expansion or new dependency.

- [ ] G1: Restricted PostgreSQL and authenticated engine HTTP prove unique workflow chats, atomic creation, stored ordered messages, current workflow title, workspace/user scope, independent archiving, migration rollback and registered tenant/workspace erasure
  CHECK: node .unlazy/verify-storage.mjs
  EXPECT: workflow-chat-storage-passed
  EVIDENCE: pending

- [ ] G2: Native planner/compiler transports reached from the platform chat retain original goal and multiple clarification rounds, return complete connection requirements, save compiled versions and persist replies that describe the actual result
  CHECK: node .unlazy/verify-builder.mjs
  EXPECT: workflow-chat-builder-passed
  EVIDENCE: pending

- [ ] G3: Real caller-authenticated read boundaries and actual Model Gateway/cost recording prove Ask Alter sees readable workspace workflows, recent runs, failures, verification and billed spend; it cannot change existing workflows and its only action creates a draft/chat handoff
  CHECK: node .unlazy/verify-assistant.mjs
  EXPECT: workflow-chat-assistant-passed
  EVIDENCE: pending

- [ ] G4: All six web methods use live HTTP; rendered home, workflow chat and Ask Alter use actual returned identities, show clarification/results/errors and route draft handoff without mock fallback
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: workflow-chat-web-passed
  EVIDENCE: pending

- [ ] G5: Removing each consequential scope, ownership, atomicity, context preservation, read-only action, costing or live-route check fails its known-positive native assertion; restored sources pass
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: workflow-chat-negative-passed
  EVIDENCE: pending

- [ ] G6: Full touched suites including platform folder coverage, build/typecheck/lint, migration/erasure registration, architecture, RBAC, naming and zero added normalized AST findings pass with actual CI discovery
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: workflow-chat-final-passed
  EVIDENCE: pending
