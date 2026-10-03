# Gates: D20 manual node overrides (C117)

OWNS: apps/orchestration-service/src/registry/handlers/toolcall.handler.ts, apps/orchestration-service/src/approvals/approval-modes.integration.spec.ts, packages/contracts/src/openapi.ts, packages/contracts/src/openapi.spec.ts, packages/contracts/openapi.json, apps/orchestration-service/src/registry/handlers/toolcall.integration.spec.ts, apps/orchestration-service/src/workflow-chat/workflow-chat.integration.spec.ts, packages/contracts/src/node-overrides.ts, packages/contracts/src/node-overrides.spec.ts, packages/contracts/src/workflow-dag.ts, packages/contracts/src/workflow-dag.spec.ts, packages/contracts/src/index.ts, apps/intelligence-service/src/selection_binding/**, apps/intelligence-service/src/capability_registry/models.py, apps/intelligence-service/src/capability_registry/repository.py, apps/intelligence-service/tests/test_node_override_critique.py, apps/intelligence-service/tests/test_architecture_binding_integration.py, apps/orchestration-service/src/compiler/architecture-dag-builder.ts, apps/orchestration-service/src/compiler/architecture-dag-builder.spec.ts, apps/orchestration-service/src/compiler/architecture-compiler.integration.spec.ts, apps/orchestration-service/src/node-overrides/**, apps/orchestration-service/src/workflow-read/**, apps/orchestration-service/src/workflow-authoring.module.ts, apps/orchestration-service/src/registry/handlers/llmtask.handler.ts, apps/orchestration-service/src/registry/handlers/llmtask.handler.spec.ts, apps/orchestration-service/src/budgets/model-calls.ts, apps/orchestration-service/src/budgets/worst-case-run-cost-estimator.spec.ts, apps/orchestration-service/src/config/environment.ts, apps/orchestration-service/src/config/environment.spec.ts, apps/platform-api/src/workflows/**, apps/platform-api/src/planner-facade/planner-facade.module.ts, apps/platform-api/src/config/env.schema.ts, apps/platform-web/src/api/node-overrides.ts, apps/platform-web/src/api/node-overrides.spec.ts, apps/platform-web/src/api/client.ts, apps/platform-web/src/api/compile-dag.ts, apps/platform-web/src/api/compile-dag.spec.ts, apps/platform-web/src/features/workflows/components/builder/inspector.tsx, apps/platform-web/src/features/workflows/components/builder/validation-panel.tsx, apps/platform-web/src/features/workflows/components/builder/node-override-controls.tsx, apps/platform-web/src/features/workflows/components/builder/node-override-controls.spec.tsx, apps/platform-web/src/features/workflows/pages/workflow-builder.tsx, apps/platform-web/src/features/workflows/stores/useBuilderStore.ts, scripts/gates/baseline.json, docs/work-queue.md, docs/specs/07-env-config-spec.md

Scope: Both model aliases and canonical tools can be overridden per node. Advice uses actual scoped registry facts, original immutable compiler binding evidence and the existing D4 run bound; material warnings remain advisory. Every manual edit revalidates the actual graph, and the chosen values survive saving and reach execution. Unknown legacy or provider facts are reported without invented scores.

- [x] G1: Rule-derived critique cases reuse SelectionBinding scoring, retain original reason/factors, and detect tier, capability, outside action, permission/scope, latency differences
  CHECK: node .unlazy/verify-critique.mjs
  EXPECT: overrides-critique-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=088fbce317850dd559f1e33b0ba9c1e99f6d6a7416c8e7ae2c71177364859544; exit=0; EXPECT=matched; output-sha256=265f159d26a477acba92758012bab334d5f9b1e1282729a20d9938e12f3a5f25; output-bytes=29; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-node-overrides-c117; path=2b1f1cc87037/31 entries

- [x] G2: Shared validation for graphs with manual choices rejects cycles, unreachable nodes and declared type incompatibility; compiler evidence and manual choices round-trip without moving into presentation configuration
  CHECK: node .unlazy/verify-contracts.mjs
  EXPECT: overrides-contracts-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=d4be541726e7f35f2ac198c0bf2ea53d70032252a9c8f02937d470f5c196602d; exit=0; EXPECT=matched; output-sha256=4fa7ccdb1044110d9448ecced5e020fb3a07d707a24390272889700b9fce7c20; output-bytes=216; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-node-overrides-c117; path=2b1f1cc87037/31 entries

- [x] G3: Ordinary PostgreSQL and signed engine HTTP preserve server original binding evidence, enforce workflow/workspace scope, compare actual D4 bounds at both configurable cost thresholds, and persist a validated manual edit
  CHECK: node .unlazy/verify-native.mjs
  EXPECT: overrides-native-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=33df2bd313438faa0fa106b948b9f1deeb11ac532a149cc7501c2416b6da0089; exit=0; EXPECT=matched; output-sha256=865911118b126086d453b52fe5df2f82f381b9ee1eeec02adf3dee471c39e4fa; output-bytes=78; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-node-overrides-c117; path=2b1f1cc87037/31 entries

- [x] G4: Manual model choice wins runtime binding and uses the same chosen alias for cost estimates; canonical tool choice still runs through the existing Tool Gateway path and retains the actual Temporal approval wait
  CHECK: node .unlazy/verify-runtime.mjs
  EXPECT: overrides-runtime-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1b49bffa220fd51d39f04df6a2061090d0ada036eb52209cd98f70aa9aa7c2f9; exit=0; EXPECT=matched; output-sha256=c83781d1f1b3aee2d838f74aff5102831fb03fc241eb23a70ef7a891af8e242d; output-bytes=166; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-node-overrides-c117; path=2b1f1cc87037/31 entries

- [x] G5: Actual public caller-bound routes and live inspector let editors override models/tools, show original pick and scored advice, rerun graph validation and retain edits during errors; mocks mirror the interaction
  CHECK: node .unlazy/verify-public-web.mjs
  EXPECT: overrides-public-web-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8c12bff75995ca621f951f8b8db72e41306a05722f9bae7d4e245b139efb9c57; exit=0; EXPECT=matched; output-sha256=70d1be159edbdc4590f5968c6cc508b556b47efd9d19ba090398d7d3955ab018; output-bytes=190; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-node-overrides-c117; path=2b1f1cc87037/31 entries

- [x] G6: Each key regression test fails under a unique production mutation and passes after restoration
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: overrides-controls-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1ae6a29d91b5c3dd8540cca826bbc24915a8ef7370bfc59e81271ccc431350a1; exit=0; EXPECT=matched; output-sha256=d3f87f85e6cf8188208546bfb5d71bb9feb17054633b82c8a8b789e63c08190d; output-bytes=2114; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-node-overrides-c117; path=2b1f1cc87037/31 entries

- [x] G7: Full touched suites, coverage, build/typecheck/lint, Python checks, actual CI discovery, architecture/RBAC/naming/rollback and zero added normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: overrides-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=f8419686ad947d59b6d49b2c5c29bc91c7ec40d56ff091d7103fbc3e757882ee; exit=0; EXPECT=matched; output-sha256=88f84fc5990a99bf77a3cc2fa1234dd83eeeb3451ea9508d82432ed08bc0f68e; output-bytes=786; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-node-overrides-c117; path=2b1f1cc87037/31 entries
