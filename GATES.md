# Gates: D13 recovery clarification routes (C95)

OWNS: apps/orchestration-service/src/recovery/**, apps/orchestration-service/src/registry/**, apps/orchestration-service/src/clarifications/**, apps/orchestration-service/src/execution-runtime.module.ts, apps/orchestration-service/db/schema/clarifications.ts, apps/orchestration-service/drizzle/**, apps/orchestration-service/src/database/**, apps/orchestration-service/src/deletion/**, apps/platform-web/src/api/**, packages/adapters/src/grpc/nodeexec-grpc-transport*, packages/adapters/src/temporal/activities/executor-activities*, docs/work-queue.md

Scope: Missing targets produce a redirect/recreate question. Ambiguous side effects require clarification without retry or swap, including promoted policies and repeated recovery. Existing tenant-scoped clarification and D1 notice routes carry the request.

- [x] G1: Recovery dispatch persists real tenant-scoped clarifications with the correct questions and never retries ambiguous side effects
  CHECK: node_modules/.bin/vitest run apps/orchestration-service/src/recovery/recovery-clarification.integration.spec.ts apps/orchestration-service/src/recovery/recovery-dispatch.service.spec.ts -t 'Postgres|HTTP|RecoveryDispatch' && echo recovery-clarification-passed
  EXPECT: recovery-clarification-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=b0f94b0f36247f172dfc55c4ef55b857bc6d4c9389395f7cf4296711e1b9e98c; exit=0; EXPECT=matched; output-sha256=701d242cbdcf1fe221044a4f48878644ac9ca6a370f5d775c93b4d4757a23ee7; output-bytes=665; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-recovery-dispatch-c95; path=b33e9cf43ae9/31 entries

- [x] G2: Actual tool and node producers emit missing-target and ambiguous-outcome observations, and policy routing stays clarification only
  CHECK: node_modules/.bin/vitest run apps/orchestration-service/src/registry/nodeexec.service.spec.ts apps/orchestration-service/src/recovery/failure-classifier.spec.ts apps/orchestration-service/src/recovery/recovery-strategy-table.spec.ts packages/adapters/src/grpc/nodeexec-grpc-transport.spec.ts packages/adapters/src/temporal/activities/executor-activities.spec.ts && echo recovery-producers-passed
  EXPECT: recovery-producers-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=e479e61c4a543d50ec30fb3925773ec7ffbb7d8fb9302d21109881493d15dc73; exit=0; EXPECT=matched; output-sha256=72911532ad4a1e8abb00f4bcfaba701a4c66d0fae34bfe11fb877ad334090b4c; output-bytes=2228; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-recovery-dispatch-c95; path=b33e9cf43ae9/31 entries

- [x] G3: Real Temporal executor parks for clarification and resumes or terminates without replaying uncertain side effects
  CHECK: node_modules/.bin/vitest run apps/orchestration-service/src/recovery/recovery-clarification.integration.spec.ts -t Temporal && echo recovery-executor-passed
  EXPECT: recovery-executor-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=7de6882700d9b20af2c6c38afd60db3c81c63b2776152eada381220e5f38e7c2; exit=0; EXPECT=matched; output-sha256=0c9375235e0ab4c2ef73d51b8927cd1e6979eda75667fc2d1d6abf72df5d6bc8; output-bytes=14518; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-recovery-dispatch-c95; path=b33e9cf43ae9/31 entries

- [x] G4: Original-code and mutation controls fail the behavior checks and restore sources
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: recovery-clarification-negative-controls-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1dd6961e3fb5ede88c4cfe95679ddfce1cd5287faa6996da972e90b0ba9ba266; exit=0; EXPECT=matched; output-sha256=e1425edcc980d991f3c7c375895613f7b9b5acb653f2a292389964c5c9fc57b5; output-bytes=620; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-recovery-dispatch-c95; path=b33e9cf43ae9/31 entries

- [ ] G5: Builds, typecheck, lint, full affected suites, architecture and zero new AST entries pass
  CHECK: node .unlazy/verify-full.mjs
  EXPECT: recovery-clarification-full-passed
