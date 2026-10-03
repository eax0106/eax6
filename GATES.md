# Gates: Engine collection read context (C113)

OWNS: apps/orchestration-service/src/workspace-read-scope.ts, apps/orchestration-service/src/workspace-read-scope.integration.spec.ts, apps/orchestration-service/src/runs/runs.controller.ts, apps/orchestration-service/src/runs/run-launcher.service.ts, apps/orchestration-service/src/runs/node-executions.controller.ts, apps/orchestration-service/src/runs/node-execution-ledger.service.ts, apps/orchestration-service/src/runs/run-observability.controller.ts, apps/orchestration-service/src/runs/run-observability.service.ts, apps/orchestration-service/src/runs/run-stream.controller.ts, apps/orchestration-service/src/runs/run-stream-event.service.ts, apps/orchestration-service/src/approvals/approvals.controller.ts, apps/orchestration-service/src/approvals/approvals.service.ts, apps/orchestration-service/src/clarifications/clarifications.controller.ts, apps/orchestration-service/src/clarifications/clarifications.service.ts, apps/orchestration-service/src/escalations/escalations.controller.ts, apps/orchestration-service/src/escalations/escalations.service.ts, apps/orchestration-service/src/trigger-registry/trigger-registry.controller.ts, apps/orchestration-service/src/trigger-registry/trigger-registry.service.ts, apps/orchestration-service/src/trigger-registry/event.controller.ts, apps/orchestration-service/src/trigger-registry/event-query.service.ts, apps/orchestration-service/src/artifacts/artifacts.controller.ts, apps/orchestration-service/src/artifacts/artifacts.service.ts, apps/orchestration-service/src/trigger-bindings/trigger-binding.controller.ts, apps/orchestration-service/src/trigger-bindings/trigger-binding.service.ts, apps/orchestration-service/src/trigger-bindings/postgres-trigger-binding.store.ts, apps/orchestration-service/src/template-variables/template-variables.controller.ts, apps/orchestration-service/src/template-variables/template-variables.service.ts, apps/orchestration-service/src/workflow-read/workflow-read.controller.ts, apps/orchestration-service/src/workflow-read/workflow-read.service.ts, apps/orchestration-service/src/project-read/project-read.controller.ts, apps/orchestration-service/src/project-read/project-domain.service.ts, apps/orchestration-service/src/approvals/approvals.controller.spec.ts, apps/orchestration-service/src/escalations/escalations.controller.spec.ts, apps/orchestration-service/src/runs/node-executions.controller.spec.ts, apps/orchestration-service/src/runs/runs.controller.spec.ts, apps/orchestration-service/src/clarifications/clarifications.service.spec.ts, apps/orchestration-service/src/trigger-registry/event-query.service.spec.ts, scripts/gates/baseline.json, docs/work-queue.md

Scope: Existing engine collection reads carry validated actor workspace context through SQL filters and cursor ownership. Ordinary actors require a valid workspace; only the signed D1 system principal retains explicitly tenant-wide read-only audited access. Audit all engine HTTP collection surfaces, including nested collections and streams, against actual callers and stores. No new service, migration, shared contract or dependency.

- [x] G1: Restricted PostgreSQL proves actual workspace-filtered runs, approvals, clarifications, escalations, triggers and events with filters and pagination, foreign cursor rejection and tenant RLS
  CHECK: node .unlazy/verify-collections.mjs
  EXPECT: workspace-collections-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=f62d9cf275f09b0865b2ad8381bc8579960855b8066dcab48fcbad319409ea70; exit=0; EXPECT=matched; output-sha256=2b900e3bf77538df9abbe7e3cd240f4c46e7f5873efdb62b9292e9943a6fa1ae; output-bytes=30; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workspace-reads-c113; path=b33e9cf43ae9/31 entries

- [x] G2: Actual run/workflow/project/trigger parent ownership governs nested collection reads and stream visibility; existing metadata and system-only feeds retain their declared behavior
  CHECK: node .unlazy/verify-nested.mjs
  EXPECT: workspace-nested-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4f467e6bfbb82895aa574910298eedacdc1558ad6958c787cb5c6de04273ca1c; exit=0; EXPECT=matched; output-sha256=85bbfcdc1b715ac23a96d317c60a5e84d098fef4c55497ede82ef93667ad1b8a; output-bytes=25; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workspace-reads-c113; path=b33e9cf43ae9/31 entries

- [x] G3: Real signed machine and actor HTTP guards derive scope from the caller, ignore a supplied workspace query, refuse missing/invalid delegation and token replay, and preserve read-only audited D1 system access
  CHECK: node .unlazy/verify-http.mjs
  EXPECT: workspace-http-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=3836dda82ff309223f06a4669d1b296cf3207b884fd0a25dd68734b74ff0c1a8; exit=0; EXPECT=matched; output-sha256=a8ee711bf9f66a97f5d60bdb768fc51eeed667bb48c0078d9cbdf3cf8e8792ed; output-bytes=23; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workspace-reads-c113; path=b33e9cf43ae9/31 entries

- [x] G4: Removing actual workspace propagation, SQL collection scope, cursor ownership, nested parent ownership or explicit system exemption fails known-positive native assertions; restored sources pass
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: workspace-negative-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=31937bc41b2840744762f6f536fb84afd83534019c399bd58520ee074bb06229; exit=0; EXPECT=matched; output-sha256=774f652a1a303f5f0e89413c0ac70a4d48f11d74a667729e57d32ee95cfc4201; output-bytes=1558; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workspace-reads-c113; path=b33e9cf43ae9/31 entries

- [ ] G5: Complete engine test discovery and suite, touched build/typecheck/lint, architecture/RBAC/migration/naming, collection audit inventory and zero new normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: workspace-final-passed
  EVIDENCE: pending
