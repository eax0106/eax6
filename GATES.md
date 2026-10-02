# Gates: D11 stored event replay (C97)

OWNS: apps/orchestration-service/src/trigger-registry/**, apps/orchestration-service/src/runs/**, apps/orchestration-service/src/workflow-read/**, apps/orchestration-service/src/blackboard/blackboard.service.ts, apps/orchestration-service/src/ingress.module.ts, apps/orchestration-service/src/run-launcher.module.ts, apps/orchestration-service/db/schema/runs.ts, apps/orchestration-service/drizzle/**, apps/orchestration-service/src/database/**, apps/platform-api/src/events/**, apps/platform-api/src/rbac/param-workspace.resolver*, apps/platform-web/src/api/**, apps/platform-web/src/features/events/**, packages/adapters/src/temporal/workflows/executor-workflow*, packages/adapters/src/postgres/orchestration-store-provider.spec.ts, docs/work-queue.md

Scope: Replay defaults to the existing structural Simulate over the stored event. A separate real replay lists canonical outside actions, requires a current confirmation bound to the actual caller/event/version, records who confirmed and the source event, and delivers stored input to the existing executor. Real replay retains run budgets, holds, permissions and idempotency.

- [x] G1: Restricted Postgres and guarded HTTP prove dry replay uses stored payload with no run or outside calls, isolated reads and current confirmation checks
  CHECK: node_modules/.bin/vitest run apps/orchestration-service/src/trigger-registry/event-replay.integration.spec.ts -t 'Postgres|HTTP' && echo event-replay-read-passed
  EXPECT: event-replay-read-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=212b84e3b1e3f24a29551b3851cf8a1e6f622bebe74d5f2894b26d9beff102a5; exit=0; EXPECT=matched; output-sha256=355252f425a10038f4aed28c30352ba2ef53bc437dd640525dd787a9105e6569; output-bytes=3190; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-event-replay-c97; path=b33e9cf43ae9/31 entries

- [x] G2: Real Temporal receives the stored input, persisted source and confirmer, one run per request, and existing budget/hold/audit failures roll back
  CHECK: node_modules/.bin/vitest run apps/orchestration-service/src/trigger-registry/event-replay.integration.spec.ts -t 'Temporal|transaction' && echo event-replay-execution-passed
  EXPECT: event-replay-execution-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a52b8f6a7cbf9ca30822e7aa9be2aee453f3acc7004d6ebe54e4fe0a0f128df9; exit=0; EXPECT=matched; output-sha256=5fc70024ccb9cec761bfa51a5bb3f139556d23af4fe31c417860af6dbf4bf434; output-bytes=3195; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-event-replay-c97; path=b33e9cf43ae9/31 entries

- [x] G3: Platform relay preserves real caller and run permission; rendered web defaults to dry replay and names outside actions before confirmed real replay
  CHECK: node .unlazy/verify-platform.mjs && node_modules/.bin/vitest run --config apps/platform-web/vitest.config.ts apps/platform-web/src/features/events apps/platform-web/src/api/live-events.spec.ts && echo event-replay-surfaces-passed
  EXPECT: event-replay-surfaces-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=00c3af538150186600cc740511019fff48717fd7285fd154cefdd79d1de35a4e; exit=0; EXPECT=matched; output-sha256=1cb0546b16cc4072244796683e0142f9197361b87bfed5ea76ffe9976bd1f448; output-bytes=324; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-event-replay-c97; path=b33e9cf43ae9/31 entries

- [x] G4: Original-code and mutation controls fail their corresponding assertions and restore sources
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: event-replay-negative-controls-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=621f34e480782315d3aad18b64c50d5256f7a1c8e1e65f6ddb5cb2322e53cf83; exit=0; EXPECT=matched; output-sha256=d8e51a8ba4975fd92aa094e66b6cc8bf016fecf21f218ac0586ee5d548adaac9; output-bytes=349; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-event-replay-c97; path=b33e9cf43ae9/31 entries

- [x] G5: Full affected builds, typechecks, lint, suites, migration pairing, RBAC, architecture and zero added AST findings pass
  CHECK: node .unlazy/verify-full.mjs
  EXPECT: event-replay-full-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a75529c8ea4b793a51b3debafbf03a8e9c616001ca1d22d4f324db3ea070b492; exit=0; EXPECT=matched; output-sha256=5cdc49a46b8332c900ba55f0ad592dcac3e7e893673fe63537df1af5c82f14a0; output-bytes=475; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-event-replay-c97; path=b33e9cf43ae9/31 entries
