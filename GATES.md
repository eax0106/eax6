# Gates: D20 manual node overrides (C117)

OWNS: packages/contracts/src/node-overrides.ts, packages/contracts/src/node-overrides.spec.ts, packages/contracts/src/workflow-dag.ts, packages/contracts/src/workflow-dag.spec.ts, packages/contracts/src/index.ts, apps/intelligence-service/src/selection_binding/**, apps/intelligence-service/src/capability_registry/models.py, apps/intelligence-service/src/capability_registry/repository.py, apps/intelligence-service/tests/test_node_override_critique.py, apps/intelligence-service/tests/test_architecture_binding_integration.py, apps/orchestration-service/src/compiler/architecture-dag-builder.ts, apps/orchestration-service/src/compiler/architecture-dag-builder.spec.ts, apps/orchestration-service/src/compiler/architecture-compiler.integration.spec.ts, apps/orchestration-service/src/node-overrides/**, apps/orchestration-service/src/workflow-read/**, apps/orchestration-service/src/workflow-authoring.module.ts, apps/orchestration-service/src/registry/handlers/llmtask.handler.ts, apps/orchestration-service/src/registry/handlers/llmtask.handler.spec.ts, apps/orchestration-service/src/budgets/model-calls.ts, apps/orchestration-service/src/budgets/worst-case-run-cost-estimator.spec.ts, apps/orchestration-service/src/config/environment.ts, apps/platform-api/src/workflows/**, apps/platform-api/src/config/env.schema.ts, apps/platform-web/src/api/node-overrides.ts, apps/platform-web/src/api/node-overrides.spec.ts, apps/platform-web/src/api/client.ts, apps/platform-web/src/api/compile-dag.ts, apps/platform-web/src/api/compile-dag.spec.ts, apps/platform-web/src/features/workflows/components/builder/inspector.tsx, apps/platform-web/src/features/workflows/components/builder/node-override-controls.tsx, apps/platform-web/src/features/workflows/components/builder/node-override-controls.spec.tsx, apps/platform-web/src/features/workflows/pages/workflow-builder.tsx, apps/platform-web/src/features/workflows/stores/useBuilderStore.ts, scripts/gates/baseline.json, docs/work-queue.md, docs/specs/07-env-config-spec.md

Scope: Both model aliases and canonical tools can be overridden per node. Advice uses actual scoped registry facts, original immutable compiler binding evidence and the existing D4 run bound; material warnings remain advisory. Every manual edit revalidates the actual graph, and the chosen values survive saving and reach execution. Unknown legacy or provider facts are reported without invented scores.

- [ ] G1: Rule-derived critique cases reuse SelectionBinding scoring, retain original reason/factors, and detect tier, capability, outside action, permission/scope, latency differences
  CHECK: node .unlazy/verify-critique.mjs
  EXPECT: overrides-critique-passed
  EVIDENCE: pending

- [ ] G2: Shared validation for graphs with manual choices rejects cycles, unreachable nodes and declared type incompatibility; compiler evidence and manual choices round-trip without moving into presentation configuration
  CHECK: node .unlazy/verify-contracts.mjs
  EXPECT: overrides-contracts-passed
  EVIDENCE: pending

- [ ] G3: Ordinary PostgreSQL and signed engine HTTP preserve server original binding evidence, enforce workflow/workspace scope, compare actual D4 bounds at both configurable cost thresholds, and persist a validated manual edit
  CHECK: node .unlazy/verify-native.mjs
  EXPECT: overrides-native-passed
  EVIDENCE: pending

- [ ] G4: Manual model choice wins runtime binding and uses the same chosen alias for cost estimates; canonical tool choice still runs through the existing Tool Gateway path
  CHECK: node .unlazy/verify-runtime.mjs
  EXPECT: overrides-runtime-passed
  EVIDENCE: pending

- [ ] G5: Actual public caller-bound routes and live inspector let editors override models/tools, show original pick and scored advice, rerun graph validation and retain edits during errors; mocks mirror the interaction
  CHECK: node .unlazy/verify-public-web.mjs
  EXPECT: overrides-public-web-passed
  EVIDENCE: pending

- [ ] G6: Each key regression test fails under a unique production mutation and passes after restoration
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: overrides-controls-passed
  EVIDENCE: pending

- [ ] G7: Full touched suites, coverage, build/typecheck/lint, Python checks, actual CI discovery, architecture/RBAC/naming/rollback and zero added normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: overrides-final-passed
  EVIDENCE: pending
