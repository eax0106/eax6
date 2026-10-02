# Gates: engine connection registry and lifecycle synchronization (C99)

OWNS: apps/platform-api/src/admin-tenants/admin-tenants.module.spec.ts, apps/platform-api/src/admin-policy/admin-policy.module.spec.ts, apps/orchestration-service/src/connections/**, apps/orchestration-service/src/operations.module.ts, apps/orchestration-service/src/deletion/**, apps/orchestration-service/src/database/migration-files.spec.ts, apps/orchestration-service/db/schema/connection_registry.ts, apps/orchestration-service/drizzle/0050*, apps/orchestration-service/drizzle/rollback/0050*, apps/orchestration-service/drizzle/meta/_journal.json, apps/platform-api/src/integrations/**, apps/platform-api/src/engine/connection-registry-client*, apps/platform-api/src/engine/engine.module.ts, apps/platform-api/src/db/schema/platform.ts, apps/platform-api/src/db/migrations/0032*, apps/platform-api/src/db/migrations/rollback/0032*, apps/platform-api/src/db/migrations/meta/_journal.json, apps/platform-api/src/db/migration-journal.spec.ts, packages/contracts/src/connection-registry*, packages/contracts/src/index.ts, packages/deletion-registry/src/declaration.ts, deploy/ec2/**, scripts/bootstrap-env-local.sh, apps/platform-api/.env.example, docs/work-queue.md, scripts/gates/baseline.json, .env.local.example, apps/platform-api/src/config/env.schema*, apps/platform-api/src/health/health.controller.spec.ts, apps/orchestration-service/src/health/health.controller.spec.ts

OWNS: apps/orchestration-service/src/config/service-token-fingerprint.ts, apps/orchestration-service/src/config/service-token-fingerprint.spec.ts

Scope: Engine stores tenant/workspace-scoped connection snapshots containing connector, status and reference only. Authenticated platform lifecycle writes and the existing health sweep synchronize every state with ordered source revisions, including lost revoke/health updates. Compiler preflight and Tool Gateway consumption are the next dependent leaf; I11 remains incomplete until those paths are verified.

- [x] G1: Restricted PostgreSQL and authenticated engine HTTP enforce reference-only snapshots, tenant/workspace isolation, ordered idempotent updates and complete tenant/workspace erasure
  CHECK: node .unlazy/verify-engine.mjs
  EXPECT: connection-registry-engine-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=254849e0b90089eb04655a7227537cd319ad14f268941d6f2b8c01c0d18d1d79; exit=0; EXPECT=matched; output-sha256=77b5152369fb9b5fa0fcb0f854a90a7ac459374bf87252b41a71ce82d34d82c3; output-bytes=98; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-connections-c99; path=b33e9cf43ae9/31 entries

- [x] G2: Real platform persistence and the production HTTP client synchronize connect, health and revoke; the sweep heals missed updates for every connection state without destroying saved credentials
  CHECK: node .unlazy/verify-platform.mjs
  EXPECT: connection-registry-lifecycle-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1ce4c348b408ebd7478799782fc5dd3040732ba7a0e16c843f2732913d28b97b; exit=0; EXPECT=matched; output-sha256=f0accf7bd23f7a923f50b64a5b89e834b219efd6e80671d6741a4318cff8a12d; output-bytes=101; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-connections-c99; path=b33e9cf43ae9/31 entries

- [x] G3: Existing connector guards, lifecycle regressions, migration/schema checks and local/EC2 configuration carry the actual synchronization credential consistently
  CHECK: node .unlazy/verify-wiring.mjs
  EXPECT: connection-registry-wiring-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=b6c25ba09230ef2bd8e1e5a0d68edf55aca0c0536fb725195f5103384ce4a811; exit=0; EXPECT=matched; output-sha256=5572487c21852611038765b4107003060903c952e6823aa40d7f32097a7d4fa2; output-bytes=339; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-connections-c99; path=b33e9cf43ae9/31 entries

- [x] G4: Removed revision checks, reference validation, erasure registration and all-state sweep each fail the corresponding regression assertion and restore their sources
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: connection-registry-negative-controls-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=36e4d54a2d423ce1549df9a48b88dba17f0322cd0eaea90179b8bf39a170fbdf; exit=0; EXPECT=matched; output-sha256=bd61b2ccefe9c1bad16f5cfa75211e3e78cb6611832bcc8814782952020d58e5; output-bytes=504; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-connections-c99; path=b33e9cf43ae9/31 entries

- [x] G5: Affected builds, typechecks, lint, full engine and platform coverage, architecture/RBAC, migration rollback pairing and zero added AST findings pass
  CHECK: node .unlazy/verify-full.mjs
  EXPECT: connection-registry-full-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=6080e3169797cbb0f838109cb51cc4cf76f3a72cb7faeca52a13775eb05d8aa7; exit=0; EXPECT=matched; output-sha256=ca5515fb5bff1981516794a4291b1137856f18eaded112ba6d4872ee1ab4c815; output-bytes=488; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-connections-c99; path=b33e9cf43ae9/31 entries
