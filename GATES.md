# Gates: D8 success criteria shown and confirmed (C116)

OWNS: apps/orchestration-service/src/workflow-chat/**, apps/orchestration-service/src/workflow-read/**, apps/platform-api/src/planner-facade/**, apps/platform-api/src/workflow-chat/**, apps/platform-web/src/api/client.ts, apps/platform-web/src/api/live.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/compile-dag.ts, apps/platform-web/src/api/compile-dag.spec.ts, apps/platform-web/src/api/clarification-flow.spec.ts, apps/platform-web/src/api/live-conversations.spec.ts, apps/platform-web/src/components/conversation/workflow-plan.tsx, apps/platform-web/src/components/conversation/workflow-plan.spec.tsx, apps/platform-web/src/features/conversations/pages/conversation-detail.tsx, apps/platform-web/src/features/conversations/pages/conversation-flow.spec.tsx, apps/platform-web/src/features/workflows/pages/workflow-create.tsx, apps/platform-web/src/features/workflows/pages/workflow-create.spec.tsx, apps/platform-web/src/features/workflows/pages/workflow-builder.tsx, apps/platform-web/src/features/workflows/pages/workflow-builder.spec.tsx, apps/platform-web/src/features/workflows/stores/useBuilderStore.ts, apps/intelligence-service/src/planner/kernel.py, apps/intelligence-service/tests/test_planner_kernel.py, apps/intelligence-service/tests/test_planner_criteria_confirmation.py, packages/contracts/src/workflow-chat.ts, packages/contracts/src/workflow-plan.ts, packages/contracts/src/workflow-plan.spec.ts, packages/contracts/src/index.ts, scripts/gates/baseline.json, docs/work-queue.md

Scope: Both active workflow builders show steps and editable criteria before compilation. Build explicitly confirms the complete edited list; decomposition reassigns it to nodes and uncovered criteria produce questions without a version. Persisted chats bind Build to their own latest server plan. Live canvas edits affecting criteria ask whether the goal changed and preserve criteria through save.

- [ ] G1: Rule-derived golden cases measure preview without compilation, authoritative edited criteria, uncovered-criterion questions and legacy no-criteria compatibility
  CHECK: node .unlazy/verify-planner.mjs
  EXPECT: criteria-planner-passed
  EVIDENCE: pending

- [ ] G2: Actual public builder routes and persisted chats require explicit Build, preserve edited criteria and scope, bind the latest plan, retain questions and replay without duplicate compilation
  CHECK: node .unlazy/verify-public.mjs
  EXPECT: criteria-public-passed
  EVIDENCE: pending

- [ ] G3: Ordinary PostgreSQL and real compiler transport persist exactly confirmed workflow and node criteria; preview and uncovered criteria persist no compiled version
  CHECK: node .unlazy/verify-native.mjs
  EXPECT: criteria-native-passed
  EVIDENCE: pending

- [ ] G4: Both rendered plan screens edit/add/remove criteria and Build them through live requests; affected live canvas edits ask about the goal, preserve unchanged criteria and retain failed requests
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: criteria-web-passed
  EVIDENCE: pending

- [ ] G5: Known-positive controls fail when confirmation, authoritative criteria, uncovered-criterion handling, latest-chat-plan binding, live request fields or canvas criteria carry/prompt are removed, then pass after restoration
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: criteria-controls-passed
  EVIDENCE: pending

- [ ] G6: Full touched suites, build/typecheck/lint, Python validation and CI discovery, architecture/RBAC/naming, and zero added normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: criteria-final-passed
  EVIDENCE: pending
