# Gates: D10 workflow health (C112)

OWNS: apps/orchestration-service/src/workflow-health/**, apps/orchestration-service/src/workflow-read/workflow-read.controller.ts, apps/orchestration-service/src/workflow-authoring.module.ts, apps/platform-api/src/workflows/**, apps/platform-web/src/api/client.ts, apps/platform-web/src/api/live.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/workflow-health.spec.ts, apps/platform-web/src/features/workflows/pages/workflow-health.tsx, apps/platform-web/src/features/workflows/pages/workflow-detail.tsx, apps/platform-web/src/features/workflows/pages/workflow-health.spec.tsx, packages/contracts/src/workflow-health.ts, packages/contracts/src/index.ts, scripts/gates/baseline.json, docs/work-queue.md

Scope: D10 uses actual recorded execution/verification evidence for validation, availability, correctness and reliability. Limit samples to the latest 20 workflow runs within 7 days in the caller's workspace. Overall averages the four observed dimensions; status follows the worst dimension, critical below 50 and warning below 80. No runs displays not enough data. Missing observations stay unknown rather than manufacturing successful scores. Use existing records and live web/API routes; no uptime promises, new service, migration or dependency.

- [x] G1: Native restricted PostgreSQL proves workspace-owned workflow reads, the actual 20-run/seven-day window, four recorded dimensions, arithmetic mean, worst-dimension thresholds and honest empty/missing evidence
  CHECK: node .unlazy/verify-engine.mjs
  EXPECT: workflow-health-engine-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=99bda42a973145461dace725fa024b19c202f65e66a264f4debb6e2de0c5d039; exit=0; EXPECT=matched; output-sha256=9c7ca9d44bb2238033adb530762bb4f95dd12a167042bc4cda7ef32fb82dcc3d; output-bytes=82; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workflow-health-c112; path=b33e9cf43ae9/31 entries

- [x] G2: Authenticated engine/platform boundaries and rendered live list/detail show the returned workflow identity, four dimensions, observed window, worst status, unknown data and errors without mock fallback
  CHECK: node .unlazy/verify-delivery.mjs
  EXPECT: workflow-health-delivery-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=9d291e9cb54db5d6b2d9e09f3aced79b11677b15cef9669d09cc815ed7060b4d; exit=0; EXPECT=matched; output-sha256=50fac5f31e190de60c0d6e47e01a767d94ed1107ebd673d56953326c9a13c519; output-bytes=138; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workflow-health-c112; path=b33e9cf43ae9/31 entries

- [x] G3: Known-positive original assertions fail when workspace scope, time/count bounds, four-dimension mean, worst threshold or live routing is removed; restored code passes
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: workflow-health-negative-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5ed9246241b57ebf2bb884564f2558067eecdaa73e8b14ba3b237fe475303698; exit=0; EXPECT=matched; output-sha256=8235e0203b7405a4c2b89dac424eb55727379ba4c7bad0f3b06fc1eec625e626; output-bytes=6137; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workflow-health-c112; path=b33e9cf43ae9/31 entries

- [x] G4: Complete touched suites, platform coverage, build/typecheck/lint, actual engine CI discovery, architecture/RBAC/naming and zero added normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: workflow-health-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=725401096d12586f4b3ff121fcea4a75b0a2fd0a1828697fafc8ce4b8e5e59e5; exit=0; EXPECT=matched; output-sha256=168a15e7b4605c9743b94064128b8b52def47b3f7bfb6208d6bb7adec0962b38; output-bytes=608; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-workflow-health-c112; path=b33e9cf43ae9/31 entries
