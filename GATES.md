# Gates: D11 stored event replay (C97)

OWNS: apps/orchestration-service/src/trigger-registry/**, apps/orchestration-service/src/runs/**, apps/orchestration-service/src/workflow-read/**, apps/orchestration-service/src/blackboard/blackboard.service.ts, apps/orchestration-service/src/ingress.module.ts, apps/orchestration-service/src/run-launcher.module.ts, apps/orchestration-service/db/schema/runs.ts, apps/orchestration-service/drizzle/**, apps/orchestration-service/src/database/**, apps/platform-api/src/events/**, apps/platform-api/src/rbac/param-workspace.resolver*, apps/platform-web/src/api/**, apps/platform-web/src/features/events/**, packages/adapters/src/temporal/workflows/executor-workflow*, docs/work-queue.md

Scope: Replay defaults to the existing structural Simulate over the stored event. A separate real replay lists canonical outside actions, requires a current confirmation bound to the actual caller/event/version, records who confirmed and the source event, and delivers stored input to the existing executor. Real replay retains run budgets, holds, permissions and idempotency.

- [ ] G1: Restricted Postgres and guarded HTTP prove dry replay uses stored payload with no run or outside calls, isolated reads and current confirmation checks
  CHECK: node_modules/.bin/vitest run apps/orchestration-service/src/trigger-registry/event-replay.integration.spec.ts -t 'Postgres|HTTP' && echo event-replay-read-passed
  EXPECT: event-replay-read-passed

- [ ] G2: Real Temporal receives the stored input, persisted source and confirmer, one run per request, and existing budget/hold/audit failures roll back
  CHECK: node_modules/.bin/vitest run apps/orchestration-service/src/trigger-registry/event-replay.integration.spec.ts -t 'Temporal|transaction' && echo event-replay-execution-passed
  EXPECT: event-replay-execution-passed

- [ ] G3: Platform relay preserves real caller and run permission; rendered web defaults to dry replay and names outside actions before confirmed real replay
  CHECK: node .unlazy/verify-platform.mjs && node_modules/.bin/vitest run --config apps/platform-web/vitest.config.ts apps/platform-web/src/features/events apps/platform-web/src/api/live-events.spec.ts && echo event-replay-surfaces-passed
  EXPECT: event-replay-surfaces-passed

- [ ] G4: Original-code and mutation controls fail their corresponding assertions and restore sources
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: event-replay-negative-controls-passed

- [ ] G5: Full affected builds, typechecks, lint, suites, migration pairing, RBAC, architecture and zero added AST findings pass
  CHECK: node .unlazy/verify-full.mjs
  EXPECT: event-replay-full-passed
