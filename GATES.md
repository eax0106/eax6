# Gates: D8 success criteria shown and confirmed (C116)

OWNS: apps/orchestration-service/src/workflow-chat/**, apps/orchestration-service/src/workflow-read/**, apps/platform-api/src/planner-facade/**, apps/platform-api/src/workflow-chat/**, apps/platform-web/src/api/client.ts, apps/platform-web/src/api/live.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/compile-dag.ts, apps/platform-web/src/api/compile-dag.spec.ts, apps/platform-web/src/api/clarification-flow.spec.ts, apps/platform-web/src/api/live-conversations.spec.ts, apps/platform-web/src/api/mock-workflow-plan.spec.ts, apps/platform-web/src/components/conversation/workflow-plan.tsx, apps/platform-web/src/components/conversation/workflow-plan.spec.tsx, apps/platform-web/src/features/conversations/pages/conversation-detail.tsx, apps/platform-web/src/features/conversations/pages/conversation-flow.spec.tsx, apps/platform-web/src/features/workflows/pages/workflow-create.tsx, apps/platform-web/src/features/workflows/pages/workflow-create.spec.tsx, apps/platform-web/src/features/workflows/pages/workflow-builder.tsx, apps/platform-web/src/features/workflows/pages/workflow-builder.spec.tsx, apps/platform-web/src/features/workflows/stores/useBuilderStore.ts, apps/intelligence-service/src/planner/kernel.py, apps/intelligence-service/tests/test_planner_kernel.py, apps/intelligence-service/tests/test_planner_criteria_confirmation.py, packages/contracts/src/workflow-chat.ts, packages/contracts/src/workflow-plan.ts, packages/contracts/src/workflow-plan.spec.ts, packages/contracts/src/index.ts, scripts/gates/baseline.json, docs/work-queue.md

Scope: Both active workflow builders show steps and editable criteria before compilation. Build explicitly confirms the complete edited list; decomposition reassigns it to nodes and uncovered criteria produce questions without a version. Persisted chats bind Build to their own latest server plan. Live canvas edits affecting criteria ask whether the goal changed and preserve criteria through save.

- [x] G1: Rule-derived golden cases measure preview without compilation, authoritative edited criteria, uncovered-criterion questions and legacy no-criteria compatibility
  CHECK: node .unlazy/verify-planner.mjs
  EXPECT: criteria-planner-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=9dc952d7ee9655995bb8160dd971c2c747c67ce03ae24a88574445104684cea6; exit=0; EXPECT=matched; output-sha256=254dd2f1aa619816ea6547bd504fa63a5b92f7a836fcf159557b453e45f5ef4a; output-bytes=91; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-success-criteria-c116; path=b33e9cf43ae9/31 entries

- [x] G2: Actual public builder routes and persisted chats require explicit Build, preserve edited criteria and scope, bind the latest plan, retain only recalled context/current lessons and questions, and replay without duplicate compilation
  CHECK: node .unlazy/verify-public.mjs
  EXPECT: criteria-public-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=81cc8cfaca7dea2bfa6b77a9f483c477bcc3751cddeb581519116762fa751b4c; exit=0; EXPECT=matched; output-sha256=5975fcefd8a9391a7381b46dd127586c8ced3c7cd675825e22109e4780d6b526; output-bytes=101; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-success-criteria-c116; path=b33e9cf43ae9/31 entries

- [x] G3: Ordinary PostgreSQL and real compiler transport persist exactly confirmed workflow and node criteria; preview and uncovered criteria persist no compiled version
  CHECK: node .unlazy/verify-native.mjs
  EXPECT: criteria-native-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=7f7ac180cd2a34b0326a2d14471dbd68c7da7bda2bbbe67141dc3f6afc6ff73e; exit=0; EXPECT=matched; output-sha256=351e234c9fe0a5b4a864d6d98d5b38bfd779e2a5cf26f6417418f2033b0f11ec; output-bytes=77; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-success-criteria-c116; path=b33e9cf43ae9/31 entries

- [x] G4: Both rendered plan screens edit/add/remove criteria and Build them through live requests; mock builders mirror confirmation; affected live canvas edits ask about the goal, preserve unchanged criteria and retain failed requests
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: criteria-web-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=f16dd8e5a305baa2ec42e84b9c54f11556d9b6e60089d0794362953c9ba8a4b8; exit=0; EXPECT=matched; output-sha256=f25b41a097cc346250d8283ed018bfc42c491728360d2bc1839777c45c71530e; output-bytes=74; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-success-criteria-c116; path=b33e9cf43ae9/31 entries

- [x] G5: Known-positive controls fail when confirmation, authoritative criteria, uncovered-criterion handling, latest-chat-plan binding, recalled context, live request fields or canvas criteria carry/prompt are removed, then pass after restoration
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: criteria-controls-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=ae53041a29dacf095e691b22f46a6da1b6b63c9e03e3b488957a61285cec5665; exit=0; EXPECT=matched; output-sha256=32e77241680adeb502333ea489e217c8e7467d611e00075b9d0ec2c7051e574d; output-bytes=1883; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-success-criteria-c116; path=b33e9cf43ae9/31 entries

- [x] G6: Full touched suites, build/typecheck/lint, Python validation and CI discovery, architecture/RBAC/naming, and zero added normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: criteria-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1875a45715c85f215b1de538511d94c02ca3b6529ad4d4de5fb10d49c1589fee; exit=0; EXPECT=matched; output-sha256=fcf1b7598343d63fada37e5f61297978cb004dc71cacea0489a728f7e46ae642; output-bytes=785; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-success-criteria-c116; path=b33e9cf43ae9/31 entries
